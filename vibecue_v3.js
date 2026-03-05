/**
 * VibeCue Protocol Tester v3.0
 *
 * Protocol Format (Simple Text):
 * - Command: $CMD:SUBCMD:DATA\r\n
 * - Response: #CMD:DATA\r\n or #ERR:CMD:ErrorCode\r\n
 *
 * NO binary wrapper (0xAA 0x55), NO length field, NO checksum
 * Just plain text: $<command>\r\n
 */

// Global variables
let bluetoothDevice = null;
let gattServer = null;
let writeCharacteristic = null;
let notifyCharacteristic = null;
let isConnected = false;
let evalDataRows = [];
let scanResults = [];  // Store scan results [{mac, rssi, name}]
let gattBusy = false;  // GATT operation mutex to prevent concurrent operations
let isScanning = false;  // BLE scan state for toggle button
let pendingConnMac = '';  // MAC address pending for body map registration
let pendingConnName = '';  // Device name pending for body map registration
let selectedBodyLocation = '';  // Selected body location in body map
let userDisconnecting = false;  // Flag to distinguish user-initiated vs unexpected disconnect
let isAutoReconnecting = false;  // Prevent re-entrant auto-reconnect
let waitingForResetResponse = false;  // Wait for reset completion before showing setup
let resetTimeoutId = null;  // Timeout for reset response
let registeredLocations = new Set();  // Track registered body locations
let isManualRunning = false;  // Manual mode running state
let isDSRunning = false;  // Daily Support mode running state
let isEvalRunning = false;  // Evaluation mode running state
let evalCountdownInterval = null;  // Eval countdown timer interval
let evalCountdownValue = 5;  // Eval countdown seconds remaining
let evalElapsedInterval = null;  // Eval elapsed timer interval
let evalElapsedSeconds = 0;  // Eval elapsed time in seconds
const EVAL_COUNTDOWN_SECONDS = 5;  // Countdown before eval starts
let evalChartMetric = 'speed';  // Butterfly chart metric toggle: 'speed' or 'distance'
let dsTimerInterval = null;  // DS countdown timer interval
let dsRemainingSeconds = 3600;  // DS remaining time in seconds
const DS_TOTAL_SECONDS = 3600;  // DS total duration: 60 minutes
const DS_TIMER_CIRCUMFERENCE = 2 * Math.PI * 54;  // SVG circle circumference (~339.292)

// Vibration mode settings
let vibModes = {
    1: { freq: 10, dur: 1 },
    2: { freq: 50, dur: 5 }
};
let selectedVibMode = 1;  // Currently selected mode (1 or 2)
let editingVibMode = null;  // Mode being edited in popup

// BLE Service/Characteristic UUIDs (update these to match your device)
const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';
const NOTIFY_CHAR_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';

/**
 * Build simple text protocol packet
 * @param {string} payload - Text payload (e.g., "$DM:STATUS:REQ")
 * @returns {Uint8Array} - Complete packet bytes
 */
function buildPacket(payload) {
    // Firmware expects simple text protocol: $<command>\r\n
    // NO binary wrapper (0xAA 0x55), NO length field, NO checksum

    // Add \r\n if not already present
    if (!payload.endsWith('\r\n')) {
        payload += '\r\n';
    }

    const packet = new TextEncoder().encode(payload);

    if (packet.length > 64) {
        console.error('Payload too long:', packet.length, 'bytes (max 64)');
        return null;
    }

    return packet;
}

/**
 * Parse received BLE packet (simple text protocol)
 * @param {DataView} dataView - Received data
 * @returns {string|null} - Extracted text or null if invalid
 */
function parsePacket(dataView) {
    const bytes = new Uint8Array(dataView.buffer);

    // Firmware sends simple text protocol: #<response>\r\n or $<data>\r\n
    // Just decode as text directly
    const text = new TextDecoder().decode(bytes);

    // Strip control characters (0x00-0x1F, 0x7F) and BOM (0xFEFF),
    // then trim whitespace. BLE modules may prepend invisible bytes
    // (null, BOM) especially on the first response after connection.
    return text.replace(/[\x00-\x1F\x7F\uFEFF]/g, '').trim();
}

/**
 * Toggle BLE connection (connect or disconnect)
 */
function toggleBleConnection() {
    if (isConnected) {
        disconnectBluetooth();
    } else {
        connectBluetooth();
    }
}

/**
 * Update header BLE indicator to show connecting state
 */
function updateConnectionStatusConnecting(message) {
    const bleDot = document.getElementById('bleDot');
    const bleLabel = document.getElementById('bleLabel');
    const toggleBtn = document.getElementById('bleToggleBtn');
    if (bleDot) { bleDot.classList.remove('connected'); bleDot.classList.add('connecting'); }
    if (bleLabel) bleLabel.textContent = message;
    if (toggleBtn) toggleBtn.disabled = true;
}

/**
 * Connect GATT and setup service/characteristics.
 * Retries up to maxRetries times with delay, because the BLE peripheral
 * may still hold the old connection (supervision timeout ~4-6s).
 */
async function connectGattWithRetry(device, maxRetries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            updateConnectionStatusConnecting(
                attempt === 1 ? '연결 중...' : `재시도 (${attempt}/${maxRetries})...`
            );

            // Disconnect stale GATT if lingering
            if (device.gatt.connected) {
                device.gatt.disconnect();
                await new Promise(r => setTimeout(r, 500));
            }

            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(SERVICE_UUID);
            const writeCh = await service.getCharacteristic(WRITE_CHAR_UUID);
            const notifyCh = await service.getCharacteristic(NOTIFY_CHAR_UUID);
            return { server, writeCh, notifyCh };
        } catch (err) {
            logSent(`[연결 시도 ${attempt}/${maxRetries}] 실패: ${err.message}`);
            if (attempt < maxRetries) {
                // Show countdown on UI while waiting
                for (let sec = delayMs / 1000; sec > 0; sec--) {
                    updateConnectionStatusConnecting(`재연결 대기 ${sec}초...`);
                    await new Promise(r => setTimeout(r, 1000));
                }
                // Disconnect before retrying so peripheral detects link loss
                try { device.gatt.disconnect(); } catch (_) {}
            } else {
                throw err;
            }
        }
    }
}

/**
 * Connect to Bluetooth device
 * - First connection: shows device picker (requestDevice)
 * - Reconnection: reuses existing bluetoothDevice object (gatt.connect only)
 */
async function connectBluetooth() {
    try {
        // If no previous device, show picker
        if (!bluetoothDevice) {
            const options = {
                filters: [{ name: 'VIBECUE' }],
                optionalServices: [SERVICE_UUID]
            };
            bluetoothDevice = await navigator.bluetooth.requestDevice(options);
            bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);
        }

        logSent('🔄 Connecting to ' + bluetoothDevice.name + '...');

        // Connect with retry (peripheral may need time to release old connection)
        const { server, writeCh, notifyCh } = await connectGattWithRetry(bluetoothDevice);

        // Remove connecting animation
        const bleDot = document.getElementById('bleDot');
        if (bleDot) bleDot.classList.remove('connecting');

        gattServer = server;
        writeCharacteristic = writeCh;
        notifyCharacteristic = notifyCh;

        // Start notifications
        await notifyCharacteristic.startNotifications();
        notifyCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);

        // Update UI
        isConnected = true;
        const toggleBtn = document.getElementById('bleToggleBtn');
        if (toggleBtn) toggleBtn.disabled = false;
        updateConnectionStatus(true, bluetoothDevice.name);

        logSent('🟢 Connected to: ' + bluetoothDevice.name);
        logReceived('🟢 Connection established');

    } catch (error) {
        console.error('Bluetooth connection failed:', error);

        // Clear connecting animation
        const bleDot = document.getElementById('bleDot');
        if (bleDot) bleDot.classList.remove('connecting');
        const toggleBtn = document.getElementById('bleToggleBtn');
        if (toggleBtn) toggleBtn.disabled = false;

        // Clear stale device so next attempt starts fresh with picker
        bluetoothDevice = null;
        gattServer = null;
        writeCharacteristic = null;
        notifyCharacteristic = null;

        alert('연결에 실패했습니다. 다시 시도해 주세요.');
        updateConnectionStatus(false);
    }
}

/**
 * Handle GATT disconnection event
 */
function onDisconnected(event) {
    const device = event.target;
    console.log('GATT disconnected:', device.name);

    isConnected = false;
    gattBusy = false;
    gattServer = null;
    writeCharacteristic = null;
    notifyCharacteristic = null;
    // Keep bluetoothDevice for reconnection

    updateConnectionStatus(false);

    if (userDisconnecting) {
        // User-initiated disconnect — no auto-reconnect
        userDisconnecting = false;
        logSent('🔴 연결 해제됨');
    } else if (!isAutoReconnecting) {
        // Unexpected disconnect — auto-reconnect (only if not already trying)
        logReceived('🔴 연결이 끊어졌습니다. 자동 재연결 시도...');
        autoReconnect();
    }
}

/**
 * Auto-reconnect after unexpected disconnection
 */
async function autoReconnect() {
    if (!bluetoothDevice || isAutoReconnecting) return;
    isAutoReconnecting = true;

    try {
        const { server, writeCh, notifyCh } = await connectGattWithRetry(bluetoothDevice);

        // Remove connecting animation
        const bleDot = document.getElementById('bleDot');
        if (bleDot) bleDot.classList.remove('connecting');

        gattServer = server;
        writeCharacteristic = writeCh;
        notifyCharacteristic = notifyCh;

        await notifyCharacteristic.startNotifications();
        notifyCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);

        isConnected = true;
        const toggleBtn = document.getElementById('bleToggleBtn');
        if (toggleBtn) toggleBtn.disabled = false;
        updateConnectionStatus(true, bluetoothDevice.name);

        logSent('🟢 자동 재연결 성공: ' + bluetoothDevice.name);
        logReceived('🟢 자동 재연결됨');

    } catch (error) {
        console.error('Auto-reconnect failed:', error);

        const bleDot = document.getElementById('bleDot');
        if (bleDot) bleDot.classList.remove('connecting');
        const toggleBtn = document.getElementById('bleToggleBtn');
        if (toggleBtn) toggleBtn.disabled = false;

        logReceived('🔴 자동 재연결 실패. 수동으로 연결해 주세요.');
        updateConnectionStatus(false);
    } finally {
        isAutoReconnecting = false;
    }
}

/**
 * Disconnect from Bluetooth device (user-initiated)
 */
function disconnectBluetooth() {
    userDisconnecting = true;

    if (gattServer && gattServer.connected) {
        gattServer.disconnect();
    }

    isConnected = false;
    gattBusy = false;
    // Keep bluetoothDevice for reconnection (don't null it)
    gattServer = null;
    writeCharacteristic = null;
    notifyCharacteristic = null;

    updateConnectionStatus(false);
}

/**
 * Update connection status UI
 */
function updateConnectionStatus(connected, deviceName = '') {
    const bleDot = document.getElementById('bleDot');
    const bleLabel = document.getElementById('bleLabel');
    const toggleBtn = document.getElementById('bleToggleBtn');
    if (connected) {
        if (bleDot) bleDot.classList.add('connected');
        if (bleLabel) bleLabel.textContent = deviceName || '연결됨';
        if (toggleBtn) {
            toggleBtn.textContent = '연결 해제';
            toggleBtn.classList.add('connected');
        }
    } else {
        if (bleDot) bleDot.classList.remove('connected');
        if (bleLabel) bleLabel.textContent = '미연결';
        if (toggleBtn) {
            toggleBtn.textContent = '연결';
            toggleBtn.classList.remove('connected');
        }
    }
}

/**
 * Handle incoming notifications
 */
function handleNotification(event) {
    const payload = parsePacket(event.target.value);

    if (!payload) {
        logReceived('[ERROR] Failed to parse packet');
        return;
    }

    const timestamp = new Date().toLocaleTimeString();
    logReceived(`[${timestamp}] ${payload}`);

    // Update device status
    updateDeviceStatus(payload);

    // Handle EVAL:STOP:STOP_OK response with average data
    // Format: #EVAL:STOP:STOP_OK:{L_avg},{R_avg},{L_spd},{R_spd},{asym} (Type 1,2,4)
    //         #EVAL:STOP:STOP_OK:{L_tilt},{R_tilt},{asym} (Type 3)
    if (payload.startsWith('#EVAL:STOP:STOP_OK:')) {
        handleEvalStopData(payload);
    }

    // Note: #EVAL:DATA:... is only shown in log, not added to table

    // Handle MAN timeout (format: #MAN:TIMEOUT)
    if (payload.startsWith('#MAN:TIMEOUT')) {
        logReceived('⏱️ 수동 모드 시간 종료');
        updateManualButton(false);
    }

    // Handle MAN:STOP response
    if (payload.includes('MAN:STOP')) {
        updateManualButton(false);
    }

    // Handle DS:STOP response or DS timeout
    if (payload.includes('DS:STOP') || payload.includes('DS:TIMEOUT')) {
        updateDSButton(false);
    }

    // Handle EVAL:STOP response or EVAL timeout — sync toggle button state
    if (payload.includes('EVAL:STOP') || payload.includes('EVAL:TIMEOUT')) {
        updateEvalButton(false);
    }
}

/**
 * Send VibeCue command
 * @param {string} command - Command without $ prefix (e.g., "DM:STATUS:REQ")
 */
async function sendCommand(command) {
    if (!isConnected || !writeCharacteristic) {
        alert('기기가 연결되지 않았습니다. 먼저 연결해 주세요.');
        return;
    }

    if (gattBusy) {
        logSent('[WARN] 이전 명령 처리 중입니다. 잠시 후 다시 시도하세요.');
        return;
    }

    try {
        gattBusy = true;

        // Build payload with VibeCue format
        const payload = `$${command}`;
        const packet = buildPacket(payload);

        if (!packet) {
            alert('패킷 생성에 실패했습니다. (데이터가 너무 깁니다)');
            return;
        }

        // Send via BLE - prefer writeWithoutResponse for BLE UART services
        if (writeCharacteristic.properties.writeWithoutResponse) {
            await writeCharacteristic.writeValueWithoutResponse(packet);
        } else {
            await writeCharacteristic.writeValueWithResponse(packet);
        }

        // Log
        const timestamp = new Date().toLocaleTimeString();
        logSent(`[${timestamp}] ${payload}`);
        logSent(`  → Packet: ${arrayToHex(packet)}`);

    } catch (error) {
        console.error('Send failed:', error);
        logSent('[ERROR] Send failed: ' + error.message);
    } finally {
        gattBusy = false;
    }
}

/**
 * Send device type command
 */
function sendDeviceType() {
    const type = document.getElementById('deviceType').value;
    if (!type) {
        addLog('기기유형을 먼저 선택하세요.', 'error');
        return;
    }
    sendCommand(`DM:TYPE:${type}`);
}

/**
 * Toggle BLE scan start/stop
 */
function toggleScan() {
    if (isScanning) {
        sendCommand('DM:SCAN:STOP');
    } else {
        sendCommand('DM:SCAN:START');
    }
}

/**
 * Update scan toggle button state
 */
function updateScanButton(scanning) {
    isScanning = scanning;
    const btn = document.getElementById('scanToggleBtn');
    if (btn) {
        btn.textContent = scanning ? '찾기 중지' : '기기 찾기';
    }
}

/**
 * Load device status by sending DM:STATUS:REQ
 */
function loadDeviceStatus() {
    if (!isConnected) {
        alert('BLE 기기가 연결되어 있지 않습니다.\n먼저 기기를 연결해 주세요.');
        return;
    }
    sendCommand('DM:STATUS:REQ');
}

/**
 * Toggle device status info panel visibility
 */
function toggleDeviceStatusInfo() {
    const infoEl = document.getElementById('deviceStatusInfo');
    const labelEl = document.getElementById('statusToggleLabel');
    if (infoEl.style.display === 'none' || infoEl.style.display === '') {
        infoEl.style.display = 'block';
        if (labelEl) labelEl.textContent = '▲ 기기 정보 접기';
    } else {
        infoEl.style.display = 'none';
        if (labelEl) labelEl.textContent = '▼ 기기 정보 펼치기';
    }
}

/**
 * Parse DM:STATUS response and update the status info panel
 * Format: #DM:T:{type},S:{state},C:{connected}/{slots},M:{mode}
 */
function parseDeviceStatusResponse(message) {
    const typeMap = {
        '1': '기본',
        '2': '하지집중',
        '3': '균형집중',
        '4': '전신'
    };
    const stateMap = {
        'IDLE': '설정 대기중',
        'INIT': '초기화 중',
        'SCAN': '추가 장치 스캔 중',
        'CONF': '장치 구성 중',
        'WAIT': '연결 대기 중',
        'READY': '설정 완료 (사용 가능)'
    };
    const modeMap = {
        'IDLE': '대기중',
        'MAN': '수동 모드',
        'DS': '일상 지원 모드',
        'EVAL': '평가 모드'
    };

    // Parse: #DM:STATUS:T:{type},S:{state},C:{connected}/{slots},M:{mode}
    const body = message.substring('#DM:STATUS:'.length);
    const parts = {};
    body.split(',').forEach(seg => {
        const [key, val] = seg.split(':');
        parts[key] = val;
    });

    const type = parts['T'] || '-';
    const state = parts['S'] || '-';
    const connSlots = (parts['C'] || '0/0').split('/');
    const connected = connSlots[0] || '0';
    const slots = connSlots[1] || '0';
    const mode = parts['M'] || '-';

    const expectedSlots = { '1': 2, '2': 4, '3': 1, '4': 6 };
    const connNum = parseInt(connected, 10);
    const slotsNum = parseInt(slots, 10);
    const expectedNum = expectedSlots[type] || 0;

    let statusMsg = '';
    let statusColor = '';

    if (state === 'READY' && slotsNum === expectedNum && connNum === slotsNum) {
        statusMsg = 'VibeCue가 사용 가능합니다.\n현재 동작 모드는 ' + (modeMap[mode] || mode) + '입니다.';
        statusColor = '#27ae60';
    } else if ((state === 'READY' || state === 'WAIT') && slotsNum === expectedNum && connNum < slotsNum) {
        statusMsg = '추가장치 연결 수가 부족합니다.\n추가 장치의 전원을 모두 켜주세요.';
        statusColor = '#f39c12';
    } else {
        statusMsg = 'VibeCue가 올바르게 설정되지 않았습니다.\n다시 설정해 주세요.';
        statusColor = '#e74c3c';
    }

    const infoEl = document.getElementById('deviceStatusInfo');
    console.log('[parseDeviceStatus]', { type, state, connected, slots, mode, infoEl: !!infoEl });
    if (infoEl) {
        const typeName = typeMap[type] || type;
        const reqSlots = expectedSlots[type];
        document.getElementById('dsType').textContent = reqSlots != null
            ? typeName + ' (필요 추가장치 수 ' + reqSlots + '개)'
            : typeName;
        // Update header title with device type
        const headerTitle = document.querySelector('.header-title');
        if (headerTitle) {
            headerTitle.textContent = typeName ? 'VibeCue - ' + typeName : 'VibeCue';
        }
        // Update manual mode location buttons for this device type
        updateManLocations(type);
        document.getElementById('dsState').textContent = stateMap[state] || state;
        document.getElementById('dsConnected').textContent = connected + '개';
        document.getElementById('dsSlots').textContent = slots + '개';
        document.getElementById('dsMode').textContent = modeMap[mode] || mode;

        let msgEl = document.getElementById('dsMessage');
        if (!msgEl) {
            msgEl = document.createElement('div');
            msgEl.id = 'dsMessage';
            msgEl.className = 'status-message';
            infoEl.appendChild(msgEl);
        }
        msgEl.style.color = statusColor;
        msgEl.textContent = statusMsg;

        // Show info panel and toggle button
        infoEl.style.display = 'block';
        const toggleEl = document.getElementById('deviceStatusToggle');
        if (toggleEl) {
            toggleEl.style.display = 'block';
            document.getElementById('statusToggleLabel').textContent = '▲ 기기 정보 접기';
        }
    }
}

/**
 * Vibrator location IDs per device type
 * 1=CHEST, 2=LFOOT, 3=RFOOT, 4=LARM, 5=RARM, 6=LTHIGH, 7=RTHIGH, 8=BACK
 */
const vibratorLocsByType = {
    '1': ['1'],               // 기본: 가슴
    '2': ['1', '6', '7'],     // 하지집중: 가슴, 왼허벅지, 오른허벅지
    '3': ['1', '8'],          // 균형집중: 가슴, 등
    '4': ['1', '4', '5', '6', '7']  // 전신: 가슴, 왼팔, 오른팔, 왼허벅지, 오른허벅지
};

/**
 * Update intensity slider color based on value (1-5)
 */
const intensityColors = ['#a8d8ff', '#66b2ff', '#f5c842', '#f0883a', '#e04545'];
function updateIntensityColor(val) {
    const v = parseInt(val, 10);
    const color = intensityColors[v - 1] || intensityColors[2];
    const slider = document.getElementById('manIntensity');
    slider.style.setProperty('--intensity-color', color);
    const label = document.getElementById('intensityValue');
    if (label) {
        label.textContent = v;
        label.style.color = color;
    }
}

/**
 * Toggle manual mode location button selection
 */
function toggleManLocation(el) {
    el.classList.toggle('selected');
    updateManLocCount();
}

/**
 * Update manual location selection count
 */
function updateManLocCount() {
    const count = document.querySelectorAll('.man-loc-btn.selected:not(.hidden)').length;
    const countEl = document.getElementById('manLocCount');
    if (countEl) countEl.textContent = '(' + count + '개 선택)';
}

/**
 * Update visible manual location buttons based on device type
 */
function updateManLocations(deviceType) {
    const allowedIds = vibratorLocsByType[deviceType] || [];
    document.querySelectorAll('.man-loc-btn').forEach(btn => {
        const locId = btn.getAttribute('data-loc-id');
        if (allowedIds.includes(locId)) {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
            btn.classList.remove('selected');
        }
    });
    updateManLocCount();
}

/**
 * Send manual START command with all parameters
 * Format: MAN:START:Freq,Level,Minutes,Loc1[,Loc2,...]
 */
function sendManualStart() {
    if (!isConnected) {
        alert('기기가 연결되지 않았습니다. 먼저 연결해 주세요.');
        return;
    }

    const mode = vibModes[selectedVibMode];
    const freq = mode.freq;
    const duration = mode.dur;
    const intensity = document.getElementById('manIntensity').value;

    const selected = document.querySelectorAll('.man-loc-btn.selected:not(.hidden)');
    const locations = Array.from(selected).map(btn => btn.getAttribute('data-loc-id')).join(',');

    if (!locations) {
        alert('위치를 선택해주세요');
        return;
    }

    // Combined format: MAN:START:Freq,Level,Minutes,Loc1,Loc2,...
    sendCommand(`MAN:START:${freq},${intensity},${duration},${locations}`);
    updateManualButton(true);
}

/**
 * Select vibration mode (1 or 2)
 */
function selectVibMode(modeNum) {
    selectedVibMode = modeNum;
    document.getElementById('vibModeCard1').classList.toggle('selected', modeNum === 1);
    document.getElementById('vibModeCard2').classList.toggle('selected', modeNum === 2);
}

/**
 * Open vibration mode settings popup
 */
function openVibModePopup(modeNum) {
    editingVibMode = modeNum;
    const mode = vibModes[modeNum];
    document.getElementById('vibModePopupTitle').textContent = '진동모드 ' + modeNum + ' 설정';
    document.getElementById('vibPopupFreq').value = mode.freq;
    document.getElementById('vibPopupFreqVal').textContent = mode.freq;
    document.getElementById('vibPopupDur').value = mode.dur;
    document.getElementById('vibPopupDurVal').textContent = mode.dur;
    document.getElementById('vibModeOverlay').classList.add('open');
}

/**
 * Close vibration mode settings popup (cancel)
 */
function closeVibModePopup() {
    document.getElementById('vibModeOverlay').classList.remove('open');
    editingVibMode = null;
}

/**
 * Save vibration mode settings from popup
 */
function saveVibModePopup() {
    if (!editingVibMode) return;
    const freq = parseInt(document.getElementById('vibPopupFreq').value, 10);
    const dur = parseInt(document.getElementById('vibPopupDur').value, 10);
    vibModes[editingVibMode] = { freq, dur };
    // Update card display
    document.getElementById('vibMode' + editingVibMode + 'Freq').textContent = freq;
    document.getElementById('vibMode' + editingVibMode + 'Dur').textContent = dur;
    closeVibModePopup();
}

/**
 * Toggle manual mode start/stop
 */
function toggleManual() {
    if (isManualRunning) {
        sendCommand('MAN:STOP');
        updateManualButton(false);
    } else {
        sendManualStart();
    }
}

/**
 * Update manual toggle button state
 */
function updateManualButton(running) {
    isManualRunning = running;
    const btn = document.getElementById('manToggleBtn');
    if (!btn) return;
    if (running) {
        btn.textContent = '자극 정지';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-danger');
    } else {
        btn.textContent = '자극 시작';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
    }
}

/**
 * Toggle Daily Support mode start/stop
 */
function toggleDS() {
    if (!isConnected) {
        alert('기기가 연결되지 않았습니다. 먼저 연결해 주세요.');
        return;
    }
    if (isDSRunning) {
        sendCommand('DS:STOP');
        updateDSButton(false);
    } else {
        sendCommand('DS:START');
        updateDSButton(true);
    }
}

/**
 * Update Daily Support toggle button state and guide/timer
 */
function updateDSButton(running) {
    isDSRunning = running;
    const btn = document.getElementById('dsToggleBtn');
    if (!btn) return;

    const guideBox = document.getElementById('dsGuideBox');
    const guideTitle = document.getElementById('dsGuideTitle');
    const guideIdle = document.getElementById('dsGuideIdle');
    const guideRunning = document.getElementById('dsGuideRunning');

    if (running) {
        btn.textContent = '정지';
        btn.classList.remove('btn-success');
        btn.classList.add('btn-danger');
        // Switch guide to running state
        if (guideTitle) {
            guideTitle.textContent = '동작중';
            guideTitle.style.color = 'var(--success)';
        }
        if (guideIdle) guideIdle.style.display = 'none';
        if (guideRunning) guideRunning.style.display = '';
        if (guideBox) guideBox.style.background = 'var(--success-light)';
        startDSTimer();
    } else {
        btn.textContent = '시작';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-success');
        // Restore guide to idle state
        if (guideTitle) {
            guideTitle.textContent = '일상지원 모드 안내';
            guideTitle.style.color = 'var(--primary)';
        }
        if (guideIdle) guideIdle.style.display = '';
        if (guideRunning) guideRunning.style.display = 'none';
        if (guideBox) guideBox.style.background = '#f0f4ff';
        stopDSTimer();
    }
}

/**
 * Start DS countdown timer (60 minutes)
 */
function startDSTimer() {
    stopDSTimer();  // Clear any existing timer
    dsRemainingSeconds = DS_TOTAL_SECONDS;
    updateDSTimerDisplay();
    const section = document.getElementById('dsTimerSection');
    if (section) section.style.display = '';

    dsTimerInterval = setInterval(() => {
        dsRemainingSeconds--;
        if (dsRemainingSeconds <= 0) {
            dsRemainingSeconds = 0;
            updateDSTimerDisplay();
            stopDSTimer();
            return;
        }
        updateDSTimerDisplay();
    }, 1000);
}

/**
 * Stop DS countdown timer
 */
function stopDSTimer() {
    if (dsTimerInterval) {
        clearInterval(dsTimerInterval);
        dsTimerInterval = null;
    }
    const section = document.getElementById('dsTimerSection');
    if (section) section.style.display = 'none';
}

/**
 * Update DS timer display (time text + progress ring)
 */
function updateDSTimerDisplay() {
    const minutes = Math.floor(dsRemainingSeconds / 60);
    const seconds = dsRemainingSeconds % 60;
    const timeEl = document.getElementById('dsTimerTime');
    if (timeEl) {
        timeEl.textContent = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
    const progressEl = document.getElementById('dsTimerProgress');
    if (progressEl) {
        const progress = dsRemainingSeconds / DS_TOTAL_SECONDS;
        const offset = DS_TIMER_CIRCUMFERENCE * (1 - progress);
        progressEl.style.strokeDashoffset = offset;
    }
}

/**
 * Toggle Evaluation mode start/stop
 * Flow: idle → countdown (5s) → send EVAL:START → running (elapsed timer)
 */
function toggleEval() {
    if (!isConnected) {
        alert('기기가 연결되지 않았습니다. 먼저 연결해 주세요.');
        return;
    }
    if (isEvalRunning || evalCountdownInterval) {
        // Stop: cancel countdown or stop running eval
        stopEvalCountdown();
        stopEvalElapsedTimer();
        if (isEvalRunning) {
            sendCommand('EVAL:STOP');
        }
        updateEvalState('idle');
    } else {
        // Start: begin countdown
        startEvalCountdown();
    }
}

/**
 * Start the 5-second countdown before EVAL:START
 */
function startEvalCountdown() {
    updateEvalState('countdown');
    evalCountdownValue = EVAL_COUNTDOWN_SECONDS;
    updateEvalCountdownDisplay();

    evalCountdownInterval = setInterval(() => {
        evalCountdownValue--;
        if (evalCountdownValue <= 0) {
            // Countdown finished — send EVAL:START and switch to running
            stopEvalCountdown();
            sendCommand('EVAL:START');
            updateEvalState('running');
            startEvalElapsedTimer();
            return;
        }
        updateEvalCountdownDisplay();
    }, 1000);
}

/**
 * Stop the eval countdown timer
 */
function stopEvalCountdown() {
    if (evalCountdownInterval) {
        clearInterval(evalCountdownInterval);
        evalCountdownInterval = null;
    }
}

/**
 * Update the countdown number display and progress ring
 */
function updateEvalCountdownDisplay() {
    const numEl = document.getElementById('evalCountdownNumber');
    if (numEl) {
        numEl.textContent = evalCountdownValue;
        // Re-trigger pop animation by resetting the element
        numEl.style.animation = 'none';
        numEl.offsetHeight; // force reflow
        numEl.style.animation = '';
    }
}

/**
 * Start the elapsed timer when eval is running
 */
function startEvalElapsedTimer() {
    evalElapsedSeconds = 0;
    updateEvalElapsedDisplay();
    evalElapsedInterval = setInterval(() => {
        evalElapsedSeconds++;
        updateEvalElapsedDisplay();
    }, 1000);
}

/**
 * Stop the elapsed timer
 */
function stopEvalElapsedTimer() {
    if (evalElapsedInterval) {
        clearInterval(evalElapsedInterval);
        evalElapsedInterval = null;
    }
}

/**
 * Update the elapsed time display (MM:SS)
 */
function updateEvalElapsedDisplay() {
    const minutes = Math.floor(evalElapsedSeconds / 60);
    const seconds = evalElapsedSeconds % 60;
    const timeEl = document.getElementById('evalElapsedTime');
    if (timeEl) {
        timeEl.textContent = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
}

/**
 * Update Evaluation mode UI state
 * @param {'idle'|'countdown'|'running'} state
 */
function updateEvalState(state) {
    isEvalRunning = (state === 'running');
    const btn = document.getElementById('evalToggleBtn');
    const guideBox = document.getElementById('evalGuideBox');
    const guideTitle = document.getElementById('evalGuideTitle');
    const guideIdle = document.getElementById('evalGuideIdle');
    const guideCountdown = document.getElementById('evalGuideCountdown');
    const guideRunning = document.getElementById('evalGuideRunning');

    // Hide all content sections
    if (guideIdle) guideIdle.style.display = 'none';
    if (guideCountdown) guideCountdown.style.display = 'none';
    if (guideRunning) guideRunning.style.display = 'none';

    if (state === 'idle') {
        // Idle: show guide instructions
        if (guideTitle) { guideTitle.textContent = '평가 모드 안내'; guideTitle.style.color = 'var(--warning-dark)'; }
        if (guideBox) guideBox.style.background = '#fff8ee';
        if (guideIdle) guideIdle.style.display = '';
        if (btn) { btn.textContent = '시작'; btn.classList.remove('btn-danger'); btn.classList.add('btn-warning'); }
    } else if (state === 'countdown') {
        // Countdown: preparing
        if (guideTitle) { guideTitle.textContent = '평가 모드 시작 준비중'; guideTitle.style.color = 'var(--warning)'; }
        if (guideBox) guideBox.style.background = 'var(--warning-light)';
        if (guideCountdown) guideCountdown.style.display = '';
        if (btn) { btn.textContent = '취소'; btn.classList.remove('btn-warning'); btn.classList.add('btn-danger'); }
    } else if (state === 'running') {
        // Running: evaluation in progress
        if (guideTitle) { guideTitle.textContent = '평가 중'; guideTitle.style.color = 'var(--warning-dark)'; }
        if (guideBox) guideBox.style.background = '#fff3e0';
        if (guideRunning) guideRunning.style.display = '';
        if (btn) { btn.textContent = '정지'; btn.classList.remove('btn-warning'); btn.classList.add('btn-danger'); }
    }
}

/**
 * Update Evaluation toggle button state (backward compat for response handlers)
 */
function updateEvalButton(running) {
    if (running) {
        updateEvalState('running');
    } else {
        stopEvalCountdown();
        stopEvalElapsedTimer();
        updateEvalState('idle');
    }
}

/**
 * Send connect device command
 */
function sendConnectDevice() {
    const mac = document.getElementById('connMac').value.trim().toUpperCase();
    const location = document.getElementById('connLocation').value;

    if (!mac) {
        alert('MAC 주소를 입력해 주세요.');
        return;
    }

    // Remove any colons or dashes from MAC
    const cleanMac = mac.replace(/[:-]/g, '');

    if (cleanMac.length !== 12 || !/^[0-9A-F]+$/.test(cleanMac)) {
        alert('올바르지 않은 MAC 주소입니다. 예: 5CF286477359');
        return;
    }

    sendCommand(`DM:CONN:${cleanMac}:${location}`);
}

/**
 * Add scan result to display
 */
function addScanResult(mac, rssi, name) {
    // Check if already exists
    const existing = scanResults.find(r => r.mac === mac);
    if (existing) {
        existing.rssi = rssi;  // Update RSSI
    } else {
        scanResults.push({ mac, rssi, name });
    }

    updateScanResultsDisplay();
}

/**
 * Clear scan results
 */
function clearScanResults() {
    scanResults = [];
    updateScanResultsDisplay();
}

/**
 * Update scan results display
 */
function updateScanResultsDisplay() {
    const container = document.getElementById('scanResults');

    if (scanResults.length === 0) {
        container.innerHTML = '<span style="color: #888;">스캔 결과가 없습니다.</span>';
        return;
    }

    let html = '';
    scanResults.forEach(r => {
        const rssiColor = r.rssi > -70 ? '#27ae60' : (r.rssi > -85 ? '#f39c12' : '#e74c3c');
        const escapedMac = r.mac.replace(/'/g, "\\'");
        const escapedName = r.name.replace(/'/g, "\\'");
        html += `<div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 4px; border-bottom: 1px solid #eee;">
            <div style="flex: 1; min-width: 0;">
                <span style="color: #667eea; font-weight: bold; font-size: 13px;">${r.mac}</span>
                <span style="color: #888; margin-left: 8px; font-size: 13px;">${r.name}</span>
                <span style="color: ${rssiColor}; margin-left: 8px; font-size: 12px;">${r.rssi}dBm</span>
            </div>
            <button onclick="selectScanResult('${escapedMac}','${escapedName}')" style="flex-shrink: 0; margin-left: 8px; padding: 6px 12px; background: #667eea; color: white; border: none; border-radius: 6px; font-size: 13px; cursor: pointer;">등록하기</button>
        </div>`;
    });

    container.innerHTML = html;
}

/**
 * Select scan result: stop scan and open body map popup
 */
function selectScanResult(mac, name) {
    // Auto-stop scan
    if (isScanning) {
        sendCommand('DM:SCAN:STOP');
    }
    openBodyMapPopup(mac, name || mac);
}

/**
 * Open body map popup for location selection
 */
function openBodyMapPopup(mac, name) {
    pendingConnMac = mac;
    pendingConnName = name;
    selectedBodyLocation = '';

    document.getElementById('bodymapMac').textContent = mac;
    document.getElementById('bodymapName').textContent = name;
    document.getElementById('bodymapRegisterBtn').disabled = true;

    // Update indicator states: registered vs available
    document.querySelectorAll('.body-indicator').forEach(el => {
        el.classList.remove('selected');
        const loc = el.getAttribute('data-loc');
        if (registeredLocations.has(loc)) {
            el.classList.add('registered');
        } else {
            el.classList.remove('registered');
        }
    });

    document.getElementById('bodymapOverlay').classList.add('open');
}

/**
 * Select body location on body map
 */
function selectBodyLocation(el) {
    // Clear previous selection (keep registered state)
    document.querySelectorAll('.body-indicator').forEach(ind => ind.classList.remove('selected'));
    el.classList.add('selected');
    selectedBodyLocation = el.getAttribute('data-loc');
    document.getElementById('bodymapRegisterBtn').disabled = false;
}

/**
 * Register device with selected location
 */
function registerDevice() {
    if (!pendingConnMac || !selectedBodyLocation) return;
    const registeredMac = pendingConnMac;
    sendCommand(`DM:CONN:${pendingConnMac}:${selectedBodyLocation}`);
    registeredLocations.add(selectedBodyLocation);
    // Remove registered device from scan results
    scanResults = scanResults.filter(r => r.mac !== registeredMac);
    updateScanResultsDisplay();
    closeBodyMapPopup();
}

/**
 * Complete setup: send SETUP:DONE and show completion popup
 */
function completeSetup() {
    sendCommand('DM:SETUP:DONE');
    document.getElementById('setupCompleteOverlay').classList.add('open');
}

/**
 * Close setup complete popup, then hide setup section and re-enable button
 */
function closeSetupComplete() {
    document.getElementById('setupCompleteOverlay').classList.remove('open');
    document.getElementById('setupSection').classList.remove('open');
    document.getElementById('setupStartBtn').disabled = false;
}

/**
 * Close body map popup
 */
function closeBodyMapPopup() {
    document.getElementById('bodymapOverlay').classList.remove('open');
    pendingConnMac = '';
    pendingConnName = '';
    selectedBodyLocation = '';
}

/**
 * Send custom command
 */
function sendCustomCommand() {
    const cmd = document.getElementById('customCmd').value.trim();
    if (!cmd) {
        alert('명령어를 입력해 주세요.');
        return;
    }
    sendCommand(cmd);
}

/**
 * Update device status display
 */
function updateDeviceStatus(message) {
    const statusEl = document.getElementById('deviceStatus');

    // Check if waiting for reset completion
    if (waitingForResetResponse && (message.includes('RESET_OK') || message.startsWith('#BLE:RAW:+OK'))) {
        waitingForResetResponse = false;
        if (resetTimeoutId) { clearTimeout(resetTimeoutId); resetTimeoutId = null; }
        const waitEl = document.getElementById('resetWaiting');
        if (waitEl) waitEl.style.display = 'none';
        const setupEl = document.getElementById('setupSection');
        if (setupEl) setupEl.classList.add('open');
    }

    // Parse response
    let statusHTML = '';

    // Handle BLE Master raw responses: #BLE:RAW:+OK, #BLE:RAW:+READY, etc.
    if (message.startsWith('#BLE:RAW:')) {
        const rawResp = message.substring('#BLE:RAW:'.length);
        let icon = '📨';
        let color = '#888';
        if (rawResp === '+OK') {
            icon = '✓';
            color = '#27ae60';
        } else if (rawResp === '+READY') {
            icon = '🟢';
            color = '#667eea';
        } else if (rawResp === '+MULTI') {
            icon = '🔗';
            color = '#9b59b6';
        } else if (rawResp.startsWith('+CONN')) {
            icon = '🔌';
            color = '#27ae60';
        } else if (rawResp.startsWith('+DISCONN')) {
            icon = '❌';
            color = '#e74c3c';
        }
        statusHTML = `<div style="color: ${color};"><strong>${icon} BLE Master:</strong> ${rawResp}</div>`;
    }
    // Handle DM:STATUS response: #DM:STATUS:T:{type},S:{state},C:{connected}/{slots},M:{mode}
    else if (message.startsWith('#DM:STATUS:')) {
        parseDeviceStatusResponse(message);
        statusHTML = `<div style="color: #27ae60;"><strong>✓ Status:</strong> ${message}</div>`;
    }
    // Handle scan results: #DM:SCAN:FOUND:MAC,NAME,RSSI
    else if (message.startsWith('#DM:SCAN:FOUND:')) {
        const data = message.substring('#DM:SCAN:FOUND:'.length);
        const parts = data.split(',');
        if (parts.length >= 3) {
            const mac = parts[0];
            const name = parts[1];
            const rssi = parseInt(parts[2]);
            addScanResult(mac, rssi, name);
            statusHTML = `<div style="color: #667eea;"><strong>📡 Scan:</strong> Found ${name} (${mac})</div>`;
        }
    }
    // Handle INIT_OK or SCAN_STARTED - clear scan results
    else if (message.includes('INIT_OK') || message.includes('SCAN_STARTED')) {
        clearScanResults();
        if (message.includes('SCAN_STARTED')) updateScanButton(true);
        statusHTML = `<div style="color: #27ae60;"><strong>✓ Success:</strong> ${message}</div>`;
    }
    // Handle SCAN_STOPPED
    else if (message.includes('SCAN_STOPPED')) {
        updateScanButton(false);
        statusHTML = `<div style="color: #27ae60;"><strong>✓ Success:</strong> ${message}</div>`;
    }
    // Handle duplicate MAC address
    else if (message.includes('DUP_MAC:')) {
        const parts = message.split(':');
        const mac = parts.length > 2 ? parts[2] : 'unknown';
        const existingLoc = parts.length > 3 ? parts[3] : 'unknown';
        statusHTML = `<div style="color: #f39c12;"><strong>⚠ Duplicate MAC:</strong> Device ${mac} already connected as ${existingLoc}</div>`;
    }
    // Handle duplicate location
    else if (message.includes('DUP_LOC:')) {
        const parts = message.split(':');
        const loc = parts.length > 2 ? parts[2] : 'unknown';
        const existingMac = parts.length > 3 ? parts[3] : 'unknown';
        statusHTML = `<div style="color: #f39c12;"><strong>⚠ Duplicate Location:</strong> ${loc} already assigned to ${existingMac}</div>`;
    }
    // Handle location not allowed for device type
    else if (message.includes('LOC_NOT_ALLOWED:')) {
        const parts = message.split(':');
        const loc = parts.length > 2 ? parts[2] : 'unknown';
        const type = parts.length > 3 ? parts[3] : 'unknown';
        statusHTML = `<div style="color: #e74c3c;"><strong>✗ Location Not Allowed:</strong> ${loc} is not valid for ${type}</div>`;
    }
    // Handle device type full
    else if (message.includes('TYPE_FULL:')) {
        const parts = message.split(':');
        const type = parts.length > 2 ? parts[2] : '?';
        const max = parts.length > 3 ? parts[3] : '?';
        statusHTML = `<div style="color: #e74c3c;"><strong>✗ Type Full:</strong> Type ${type} allows max ${max} devices</div>`;
    }
    // Handle no type set
    else if (message.includes('NO_TYPE')) {
        statusHTML = `<div style="color: #e74c3c;"><strong>✗ No Type:</strong> Set device type first (DM:TYPE:1-4)</div>`;
    }
    // Handle slot full
    else if (message.includes('SLOT_FULL:')) {
        const parts = message.split(':');
        const maxSlots = parts.length > 2 ? parts[2] : '8';
        statusHTML = `<div style="color: #e74c3c;"><strong>✗ Slot Full:</strong> Maximum ${maxSlots} devices allowed</div>`;
    }
    // Handle error response
    else if (message.startsWith('#ERR')) {
        statusHTML = `<div style="color: #e74c3c;"><strong>✗ Error:</strong> ${message}</div>`;
    }
    // Handle success response
    else if (message.startsWith('#')) {
        statusHTML = `<div style="color: #27ae60;"><strong>✓ Success:</strong> ${message}</div>`;
    }
    // Other message
    else {
        statusHTML = `<div>${message}</div>`;
    }

    statusEl.innerHTML = statusHTML;
}

/**
 * Handle EVAL:STOP:STOP_OK response with average data
 * Type 1,2,4 (Foot): #EVAL:STOP:STOP_OK:{L_dist},{L_speed},{R_dist},{R_speed},{asymmetry} (5 values)
 * Type 3 (Back): #EVAL:STOP:STOP_OK:{L_avg_tilt},{R_avg_tilt},{asymmetry} (3 values)
 */
function handleEvalStopData(message) {
    // Extract data part after #EVAL:STOP:STOP_OK:
    const dataMatch = message.match(/#EVAL:STOP:STOP_OK:(.+)/);
    if (!dataMatch) {
        console.warn('Failed to parse EVAL STOP data:', message);
        return;
    }

    const parts = dataMatch[1].split(',').map(s => s.trim());
    const timestamp = formatEvalTimestamp(new Date());

    if (parts.length === 5) {
        // Type 1, 2, 4: Foot sensors average (L_dist, L_speed, R_dist, R_speed, asymmetry)
        evalDataRows.push({
            type: 'foot',
            time: timestamp,
            lDist: parseInt(parts[0]),
            lSpeed: parseInt(parts[1]),
            rDist: parseInt(parts[2]),
            rSpeed: parseInt(parts[3]),
            asymmetry: parseInt(parts[4])
        });
    } else if (parts.length === 3) {
        // Type 3: Back sensor average (L_tilt, R_tilt, asymmetry) - float values
        evalDataRows.push({
            type: 'back',
            time: timestamp,
            lTilt: parseFloat(parts[0]),
            rTilt: parseFloat(parts[1]),
            asymmetry: parseInt(parts[2])
        });
    } else {
        console.warn('Unknown EVAL STOP data format:', message);
        return;
    }

    // Update table
    updateEvalTable();
    logReceived('📊 EVAL average data added to table');
}

/**
 * Update EVAL data table
 */
function updateEvalTable() {
    const tbody = document.getElementById('evalTableBody');
    const thead = document.getElementById('evalTableHead');

    // Render the butterfly chart
    renderButterflyChart();

    // Clear existing rows
    tbody.innerHTML = '';

    // Add data rows (show last 20)
    const displayRows = evalDataRows.slice(-20);

    if (displayRows.length === 0) return;

    // Check data type and update header (shows average data from EVAL:STOP)
    const dataType = displayRows[0].type;
    // Helper: split "YY.MM.DD HH:MM" into two-line cell
    const timeCell = (t) => {
        const parts = t.split(' ');
        return parts.length === 2 ? `${parts[0]}<br>${parts[1]}` : t;
    };

    if (dataType === 'foot') {
        thead.innerHTML = '<tr><th style="width:18%">시간</th><th>L거리<br>(cm)</th><th>L속도<br>(cm/s)</th><th>R거리<br>(cm)</th><th>R속도<br>(cm/s)</th><th>비대칭<br>(%)</th></tr>';
        displayRows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="white-space:normal;line-height:1.3;">${timeCell(row.time)}</td>
                <td>${row.lDist}</td>
                <td>${row.lSpeed}</td>
                <td>${row.rDist}</td>
                <td>${row.rSpeed}</td>
                <td>${row.asymmetry}</td>
            `;
            tbody.appendChild(tr);
        });
    } else if (dataType === 'back') {
        thead.innerHTML = '<tr><th style="width:22%">시간</th><th>L기울기<br>(°)</th><th>R기울기<br>(°)</th><th>비대칭<br>(%)</th></tr>';
        displayRows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="white-space:normal;line-height:1.3;">${timeCell(row.time)}</td>
                <td>${row.lTilt.toFixed(1)}</td>
                <td>${row.rTilt.toFixed(1)}</td>
                <td>${row.asymmetry}</td>
            `;
            tbody.appendChild(tr);
        });
    }
}

/**
 * Clear EVAL data
 */
function clearEvalData() {
    if (evalDataRows.length > 0 && !confirm('평가 데이터를 모두 삭제하시겠습니까?')) {
        return;
    }
    evalDataRows = [];
    updateEvalTable();
    logSent('📊 EVAL data cleared');
}

/**
 * Merge new eval rows into evalDataRows using time as dedup key.
 * Returns { added, skipped } counts.
 */
function mergeEvalData(newRows) {
    const existingTimes = new Set(evalDataRows.map(r => r.time));

    let added = 0, skipped = 0;
    newRows.forEach(row => {
        if (existingTimes.has(row.time)) {
            skipped++;
        } else {
            evalDataRows.push(row);
            existingTimes.add(row.time);
            added++;
        }
    });

    // Sort by time (YY.MM.DD HH:MM format — lexicographic = chronological)
    evalDataRows.sort((a, b) => a.time.localeCompare(b.time));

    return { added, skipped };
}

/**
 * Import EVAL data from a CSV file, merge with existing data.
 * Called by <input type="file" onchange="importEvalCsv(this)">
 */
function importEvalCsv(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const text = e.target.result.trim();
            const lines = text.split(/\r?\n/).filter(l => l.length > 0);

            if (lines.length < 2) {
                alert('CSV 파일에 데이터가 없습니다.');
                input.value = '';
                return;
            }

            // Detect type from #type: comment line or header columns
            let csvType = null;
            let headerIdx = 0;

            if (lines[0].startsWith('#type:')) {
                csvType = lines[0].replace('#type:', '').split(',')[0].trim();
                headerIdx = 1;
            }

            const header = lines[headerIdx].toLowerCase();

            if (!csvType) {
                if (header.includes('dist') || header.includes('speed')) {
                    csvType = 'foot';
                } else if (header.includes('tilt')) {
                    csvType = 'back';
                } else {
                    alert('CSV 타입을 판별할 수 없습니다.\n헤더에 Dist/Speed 또는 Tilt 정보가 필요합니다.');
                    input.value = '';
                    return;
                }
            }

            // Check type mismatch with existing data
            if (evalDataRows.length > 0 && evalDataRows[0].type !== csvType) {
                alert(`타입 불일치: 현재 데이터는 "${evalDataRows[0].type}" 이고, CSV는 "${csvType}" 입니다.\n기존 데이터를 초기화한 후 다시 시도하세요.`);
                input.value = '';
                return;
            }

            // Parse data rows
            const newRows = [];
            for (let i = headerIdx + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('#')) continue;

                const cols = line.split(',');

                if (csvType === 'foot' && cols.length >= 6) {
                    newRows.push({
                        type: 'foot',
                        time: cols[0].trim(),
                        lDist: parseInt(cols[1]) || 0,
                        lSpeed: parseInt(cols[2]) || 0,
                        rDist: parseInt(cols[3]) || 0,
                        rSpeed: parseInt(cols[4]) || 0,
                        asymmetry: parseInt(cols[5]) || 0
                    });
                } else if (csvType === 'back' && cols.length >= 4) {
                    newRows.push({
                        type: 'back',
                        time: cols[0].trim(),
                        lTilt: parseFloat(cols[1]) || 0,
                        rTilt: parseFloat(cols[2]) || 0,
                        asymmetry: parseInt(cols[3]) || 0
                    });
                }
            }

            if (newRows.length === 0) {
                alert('파싱 가능한 데이터 행이 없습니다.');
                input.value = '';
                return;
            }

            const { added, skipped } = mergeEvalData(newRows);
            updateEvalTable();

            alert(`CSV 불러오기 완료\n추가: ${added}건, 중복 스킵: ${skipped}건`);
            logSent(`📥 CSV imported: +${added}, skipped ${skipped} (${csvType})`);
        } catch (err) {
            alert('CSV 파싱 오류: ' + err.message);
            console.error('CSV import error:', err);
        }

        // Reset file input so same file can be re-selected
        input.value = '';
    };

    reader.readAsText(file, 'UTF-8');
}

/**
 * Send Position Filter (posf_sl) command to sensors
 * Format: EVAL:SEN:<posf_sl{value}>
 * Valid range: 0.05 ~ 0.3
 */
function sendPosfSlCommand() {
    const valueInput = document.getElementById('posfSlValue');
    if (!valueInput) {
        alert('Position Filter 입력 필드를 찾을 수 없습니다');
        return;
    }

    const value = parseFloat(valueInput.value);

    // Validate range
    if (isNaN(value) || value < 0.05 || value > 0.3) {
        alert('Position Filter 값은 0.05 ~ 0.3 범위여야 합니다');
        return;
    }

    // Format value to avoid floating point issues (e.g., 0.10 -> "0.1")
    const formattedValue = value.toString();

    // Build command: EVAL:SEN:<posf_sl{value}>
    const cmd = `EVAL:SEN:<posf_sl${formattedValue}>`;
    sendCommand(cmd);
}

/**
 * Download EVAL data as CSV
 */
function downloadEvalData() {
    if (evalDataRows.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    // Build CSV based on data type (average data from EVAL:STOP)
    let csv = '';
    const dataType = evalDataRows[0].type;

    // Type comment line for import compatibility
    csv += `#type:${dataType}\n`;

    if (dataType === 'foot') {
        csv += 'Time,L_Avg_Dist(cm),L_Avg_Speed(cm/s),R_Avg_Dist(cm),R_Avg_Speed(cm/s),Asymmetry(%)\n';
        evalDataRows.forEach(row => {
            csv += `${row.time},${row.lDist},${row.lSpeed},${row.rDist},${row.rSpeed},${row.asymmetry}\n`;
        });
    } else if (dataType === 'back') {
        csv += 'Time,L_Avg_Tilt(deg),R_Avg_Tilt(deg),Asymmetry(%)\n';
        evalDataRows.forEach(row => {
            csv += `${row.time},${row.lTilt.toFixed(1)},${row.rTilt.toFixed(1)},${row.asymmetry}\n`;
        });
    }

    // Download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const now = new Date();
    const filename = `eval_data_${dataType}_${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 8).replace(/:/g, '-')}.csv`;
    a.download = filename;

    a.click();
    URL.revokeObjectURL(url);

    logSent(`📥 Downloaded: ${filename}`);
}

/**
 * Format timestamp for eval data: "YY.MM.DD HH:MM"
 */
function formatEvalTimestamp(date) {
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${yy}.${mm}.${dd} ${hh}:${mi}`;
}

/**
 * Switch butterfly chart metric for foot type (speed vs distance)
 */
function switchEvalMetric(metric) {
    evalChartMetric = metric;
    document.querySelectorAll('.eval-metric-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.metric === metric);
    });
    renderButterflyChart();
}

/**
 * Escape XML special characters for safe SVG text content
 */
function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render butterfly/diverging bar chart from evalDataRows
 * Pure SVG generation — no external libraries
 */
function renderButterflyChart() {
    const container = document.getElementById('evalChartContainer');
    const chartSection = document.getElementById('evalChartSection');
    const emptyState = document.getElementById('evalEmptyState');
    const toggleDiv = document.getElementById('evalChartToggle');
    const tableDetails = document.getElementById('evalTableDetails');

    if (!container) return;

    const displayRows = evalDataRows.slice(-20);

    // Handle empty state
    if (displayRows.length === 0) {
        chartSection.style.display = 'none';
        emptyState.style.display = 'block';
        if (tableDetails) tableDetails.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    chartSection.style.display = 'block';
    emptyState.style.display = 'none';
    if (tableDetails) tableDetails.style.display = 'block';

    const dataType = displayRows[0].type;

    // Show/hide metric toggle
    if (toggleDiv) {
        toggleDiv.style.display = (dataType === 'foot') ? 'flex' : 'none';
    }

    // === SVG Layout Constants (in viewBox units) ===
    const svgWidth = 600;
    const rowHeight = 52;
    const topPadding = 8;
    const bottomPadding = 8;
    const svgHeight = topPadding + (displayRows.length * rowHeight) + bottomPadding;

    const leftPadding = 4;          // left margin so text isn't clipped
    const timeLabelWidth = 100;     // left gutter for time labels
    const rightPadding = 10;
    const barAreaStart = leftPadding + timeLabelWidth;
    const centerX = barAreaStart + (svgWidth - barAreaStart - rightPadding) / 2;
    const barAreaHalf = (svgWidth - barAreaStart - rightPadding) / 2 - 36;
    const barHeight = 24;
    const barYOffset = (rowHeight - barHeight) / 2;

    // === Extract values based on type and metric ===
    let leftValues = [];
    let rightValues = [];
    let asymValues = [];
    let timeLabels = [];
    let unitLabel = '';

    displayRows.forEach(row => {
        timeLabels.push(row.time);
        asymValues.push(row.asymmetry);

        if (dataType === 'foot') {
            if (evalChartMetric === 'speed') {
                leftValues.push(row.lSpeed);
                rightValues.push(row.rSpeed);
                unitLabel = 'cm/s';
            } else {
                leftValues.push(row.lDist);
                rightValues.push(row.rDist);
                unitLabel = 'cm';
            }
        } else {
            // back type
            leftValues.push(row.lTilt);
            rightValues.push(row.rTilt);
            unitLabel = '°';
        }
    });

    // === Calculate scale ===
    const allValues = [...leftValues, ...rightValues];
    const maxVal = Math.max(...allValues, 1);
    const scale = barAreaHalf / maxVal;

    // === Responsive: scale fonts inversely so they stay readable ===
    const containerWidth = container.clientWidth || 360;
    const fontScale = Math.max(svgWidth / containerWidth, 1);  // e.g., 600/350 ≈ 1.71
    const fs = (basePx) => Math.round(basePx * fontScale);     // scaled font size

    const pxPerUnit = containerWidth / svgWidth;
    const pixelHeight = Math.round(svgHeight * pxPerUnit);

    // Max 5 rows visible, then scroll
    const maxVisibleRows = 5;
    const maxVisibleHeight = Math.round((topPadding + maxVisibleRows * rowHeight + bottomPadding) * pxPerUnit);
    container.style.maxHeight = (displayRows.length > maxVisibleRows) ? maxVisibleHeight + 'px' : 'none';

    // Scaled sizes
    const dotR = Math.round(8 * fontScale);
    const strokeW = Math.max(1.5 * fontScale, 1.5).toFixed(1);
    const trendW = Math.max(1.5 * fontScale, 1.5).toFixed(1);
    const dotStrokeW = Math.max(2 * fontScale, 2).toFixed(1);

    // === Build SVG (width 100%, fixed pixel height for scroll) ===
    let svg = `<svg width="100%" height="${pixelHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="xMidYMin meet" xmlns="http://www.w3.org/2000/svg">`;

    // Style definitions — font sizes scaled for readability
    svg += `<style>
        .ev-axis { stroke: #9aa0aa; stroke-width: ${strokeW}; }
        .ev-grid { stroke: #eaecf0; stroke-width: 0.5; }
        .ev-time { fill: #6a7080; font-size: ${fs(13)}px; font-family: 'Segoe UI', sans-serif; }
        .ev-bar-l { fill: #6678b8; opacity: 0.85; }
        .ev-bar-r { fill: #e07070; opacity: 0.85; }
        .ev-val { font-size: ${fs(12)}px; font-family: 'Segoe UI', sans-serif; font-weight: 600; }
        .ev-val-l { fill: #5568a8; }
        .ev-val-r { fill: #c85050; }
        .ev-val-w { fill: white; }
        .ev-asym { font-size: ${fs(11)}px; font-family: 'Segoe UI', sans-serif; font-weight: 700; }
        .ev-dot-g { fill: #5a9e6f; }
        .ev-dot-m { fill: #d4944a; }
        .ev-dot-s { fill: #c86b6b; }
        .ev-trend { fill: none; stroke: #5a9e6f; stroke-width: ${trendW}; stroke-dasharray: 6 4; opacity: 0.7; }
    </style>`;

    // Center vertical axis line
    svg += `<line class="ev-axis" x1="${centerX}" y1="${topPadding}" x2="${centerX}" y2="${svgHeight - bottomPadding}" />`;

    // === First pass: collect data for trend line and render bars ===
    const asymDotPositions = [];
    let barsLayer = '';
    let dotsLayer = '';

    displayRows.forEach((row, i) => {
        const rowY = topPadding + (i * rowHeight);
        const barY = rowY + barYOffset;
        const barCenterY = barY + barHeight / 2;

        const leftVal = leftValues[i];
        const rightVal = rightValues[i];
        const asymVal = asymValues[i];

        // Horizontal grid line (row separator)
        if (i > 0) {
            barsLayer += `<line class="ev-grid" x1="${barAreaStart}" y1="${rowY}" x2="${svgWidth - rightPadding}" y2="${rowY}" />`;
        }

        // Time label (left gutter, start-aligned with left padding)
        barsLayer += `<text class="ev-time" x="${leftPadding}" y="${barCenterY}" text-anchor="start" dominant-baseline="central">${escapeXml(timeLabels[i])}</text>`;

        // Left bar (extends leftward from center)
        const leftBarWidth = Math.max(leftVal * scale, 2);
        const leftBarX = centerX - leftBarWidth;
        barsLayer += `<rect class="ev-bar-l" x="${leftBarX}" y="${barY}" width="${leftBarWidth}" height="${barHeight}" rx="3" ry="3" />`;

        // Left value label
        const leftLabelStr = dataType === 'back' ? leftVal.toFixed(1) + unitLabel : leftVal + unitLabel;
        if (leftBarWidth > 55) {
            barsLayer += `<text class="ev-val ev-val-w" x="${leftBarX + 6}" y="${barCenterY}" text-anchor="start" dominant-baseline="central">${leftLabelStr}</text>`;
        } else {
            barsLayer += `<text class="ev-val ev-val-l" x="${leftBarX - 4}" y="${barCenterY}" text-anchor="end" dominant-baseline="central">${leftLabelStr}</text>`;
        }

        // Right bar (extends rightward from center)
        const rightBarWidth = Math.max(rightVal * scale, 2);
        barsLayer += `<rect class="ev-bar-r" x="${centerX}" y="${barY}" width="${rightBarWidth}" height="${barHeight}" rx="3" ry="3" />`;

        // Right value label
        const rightLabelStr = dataType === 'back' ? rightVal.toFixed(1) + unitLabel : rightVal + unitLabel;
        if (rightBarWidth > 55) {
            barsLayer += `<text class="ev-val ev-val-w" x="${centerX + rightBarWidth - 6}" y="${barCenterY}" text-anchor="end" dominant-baseline="central">${rightLabelStr}</text>`;
        } else {
            barsLayer += `<text class="ev-val ev-val-r" x="${centerX + rightBarWidth + 4}" y="${barCenterY}" text-anchor="start" dominant-baseline="central">${rightLabelStr}</text>`;
        }

        // Asymmetry dot — position shifts toward dominant side
        const asymShift = (rightVal - leftVal) / (maxVal || 1) * (barAreaHalf * 0.5);
        const dotX = centerX + asymShift;
        const dotRadius = dotR;
        let dotClass = 'ev-dot-g';
        if (asymVal >= 20) dotClass = 'ev-dot-s';
        else if (asymVal >= 10) dotClass = 'ev-dot-m';

        // Visible dot
        dotsLayer += `<circle class="${dotClass}" cx="${dotX}" cy="${barCenterY}" r="${dotRadius}" stroke="white" stroke-width="${dotStrokeW}" />`;
        // Larger invisible touch target
        dotsLayer += `<circle class="ev-dot-touch" cx="${dotX}" cy="${barCenterY}" r="${dotRadius * 2}" fill="transparent" data-idx="${i}" style="cursor:pointer;" />`;
        // Hidden tooltip label (shown on tap)
        const lblBg = asymVal >= 20 ? '#c86b6b' : asymVal >= 10 ? '#d4944a' : '#5a9e6f';
        const lblW = fs(11) * (String(asymVal).length + 1) * 0.65;
        const lblH = fs(11) * 1.6;
        const lblY = barY - 4 - lblH;
        dotsLayer += `<g class="ev-tooltip" data-idx="${i}" style="opacity:0; pointer-events:none; transition: opacity 0.15s;">`;
        dotsLayer += `<rect x="${dotX - lblW/2}" y="${lblY}" width="${lblW}" height="${lblH}" rx="4" fill="${lblBg}" />`;
        dotsLayer += `<text x="${dotX}" y="${lblY + lblH/2}" text-anchor="middle" dominant-baseline="central" fill="white" style="font-size:${fs(11)}px; font-family:'Segoe UI',sans-serif; font-weight:700;">${asymVal}%</text>`;
        dotsLayer += `</g>`;

        asymDotPositions.push({ x: dotX, y: barCenterY });
    });

    // === Assemble SVG layers: bars → trend line → dots (on top) ===
    svg += barsLayer;

    // Trend line (behind dots)
    if (asymDotPositions.length >= 2) {
        let pathD = `M ${asymDotPositions[0].x} ${asymDotPositions[0].y}`;
        for (let i = 1; i < asymDotPositions.length; i++) {
            pathD += ` L ${asymDotPositions[i].x} ${asymDotPositions[i].y}`;
        }
        svg += `<path class="ev-trend" d="${pathD}" />`;
    }

    // Dots on top of trend line
    svg += dotsLayer;

    svg += '</svg>';

    container.innerHTML = svg;

    // === Event delegation: tap dot to show/hide tooltip ===
    const svgEl = container.querySelector('svg');
    if (svgEl) {
        svgEl.addEventListener('click', (e) => {
            const touch = e.target.closest('.ev-dot-touch');
            // Hide all tooltips first
            svgEl.querySelectorAll('.ev-tooltip').forEach(tt => {
                tt.style.opacity = '0';
                tt.style.pointerEvents = 'none';
            });
            if (touch) {
                const idx = touch.getAttribute('data-idx');
                const tooltip = svgEl.querySelector(`.ev-tooltip[data-idx="${idx}"]`);
                if (tooltip) {
                    tooltip.style.opacity = '1';
                    tooltip.style.pointerEvents = 'auto';
                }
            }
        });
    }
}

/**
 * Load sample eval data for testing (callable from browser console)
 * Usage: loadSampleEvalData('foot') or loadSampleEvalData('back')
 */
function loadSampleEvalData(type) {
    if (type === 'back') {
        evalDataRows = [
            {type:'back', time:'26.02.20 09:00', lTilt:2.1, rTilt:2.3, asymmetry:4},
            {type:'back', time:'26.02.21 10:30', lTilt:3.5, rTilt:1.8, asymmetry:18},
            {type:'back', time:'26.02.22 14:00', lTilt:5.2, rTilt:1.5, asymmetry:35},
            {type:'back', time:'26.02.23 11:00', lTilt:2.8, rTilt:2.5, asymmetry:6},
            {type:'back', time:'26.02.24 16:00', lTilt:4.0, rTilt:2.0, asymmetry:22},
            {type:'back', time:'26.02.25 09:30', lTilt:3.0, rTilt:2.8, asymmetry:3},
            {type:'back', time:'26.02.26 15:00', lTilt:2.5, rTilt:3.8, asymmetry:15},
            {type:'back', time:'26.02.27 10:00', lTilt:2.2, rTilt:2.4, asymmetry:5},
        ];
    } else {
        evalDataRows = [
            {type:'foot', time:'26.02.20 14:30', lDist:52, lSpeed:78, rDist:55, rSpeed:80, asymmetry:3},
            {type:'foot', time:'26.02.21 18:00', lDist:48, lSpeed:70, rDist:55, rSpeed:80, asymmetry:12},
            {type:'foot', time:'26.02.22 12:00', lDist:40, lSpeed:60, rDist:58, rSpeed:110, asymmetry:30},
            {type:'foot', time:'26.02.23 22:00', lDist:50, lSpeed:90, rDist:52, rSpeed:80, asymmetry:5},
            {type:'foot', time:'26.02.24 10:00', lDist:55, lSpeed:85, rDist:50, rSpeed:75, asymmetry:8},
            {type:'foot', time:'26.02.25 15:30', lDist:42, lSpeed:65, rDist:56, rSpeed:95, asymmetry:19},
            {type:'foot', time:'26.02.26 09:00', lDist:53, lSpeed:82, rDist:54, rSpeed:84, asymmetry:2},
            {type:'foot', time:'26.02.27 17:00', lDist:45, lSpeed:72, rDist:58, rSpeed:98, asymmetry:14},
        ];
    }
    updateEvalTable();
    console.log(`📊 Loaded ${evalDataRows.length} sample ${type} data rows`);
}

/**
 * Log sent message
 */
function logSent(message) {
    const log = document.getElementById('sentLog');
    log.value += message + '\n';
    log.scrollTop = log.scrollHeight;
}

/**
 * Log received message
 */
function logReceived(message) {
    const log = document.getElementById('receivedLog');
    log.value += message + '\n';
    log.scrollTop = log.scrollHeight;
}

/**
 * Convert byte array to hex string
 */
function arrayToHex(array) {
    return Array.from(array)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
}

/**
 * Initialize on page load
 */
window.addEventListener('load', () => {
    console.log('VibeCue Protocol Tester v3.0 loaded');

    // Initialize intensity slider color
    updateIntensityColor(document.getElementById('manIntensity').value);

    // Check for Web Bluetooth API support
    if (!navigator.bluetooth) {
        alert('이 브라우저는 Web Bluetooth를 지원하지 않습니다.\n\nChrome, Edge, Opera 브라우저를 사용해 주세요.');
        const toggleBtn = document.getElementById('bleToggleBtn');
        if (toggleBtn) toggleBtn.disabled = true;
    }

    logSent('🚀 VibeCue Tester v3.0 initialized');
    logSent('📱 Ready to connect...');
});

// Handle disconnection
window.addEventListener('beforeunload', () => {
    if (isConnected) {
        disconnectBluetooth();
    }
});
