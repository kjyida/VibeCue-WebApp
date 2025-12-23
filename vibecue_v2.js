/**
 * VibeCue Protocol Tester v2.0
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

    // Remove trailing whitespace
    return text.trim();
}

/**
 * Connect to Bluetooth device
 */
async function connectBluetooth() {
    const deviceName = document.getElementById('deviceName').value.trim();

    try {
        // Request device
        const options = {
            optionalServices: [SERVICE_UUID]
        };

        if (deviceName) {
            options.filters = [{ name: deviceName }];
        } else {
            options.acceptAllDevices = true;
        }

        bluetoothDevice = await navigator.bluetooth.requestDevice(options);

        // Connect to GATT server
        gattServer = await bluetoothDevice.gatt.connect();
        const service = await gattServer.getPrimaryService(SERVICE_UUID);

        // Get characteristics
        writeCharacteristic = await service.getCharacteristic(WRITE_CHAR_UUID);
        notifyCharacteristic = await service.getCharacteristic(NOTIFY_CHAR_UUID);

        // Start notifications
        await notifyCharacteristic.startNotifications();
        notifyCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);

        // Update UI
        isConnected = true;
        updateConnectionStatus(true, bluetoothDevice.name);
        document.getElementById('connectBtn').disabled = true;
        document.getElementById('disconnectBtn').disabled = false;

        logSent('🟢 Connected to: ' + bluetoothDevice.name);
        logReceived('🟢 Connection established');

    } catch (error) {
        console.error('Bluetooth connection failed:', error);
        alert('Connection failed: ' + error.message);
        updateConnectionStatus(false);
    }
}

/**
 * Disconnect from Bluetooth device
 */
function disconnectBluetooth() {
    if (gattServer && gattServer.connected) {
        gattServer.disconnect();
    }

    isConnected = false;
    bluetoothDevice = null;
    gattServer = null;
    writeCharacteristic = null;
    notifyCharacteristic = null;

    updateConnectionStatus(false);
    document.getElementById('connectBtn').disabled = false;
    document.getElementById('disconnectBtn').disabled = true;

    logSent('🔴 Disconnected');
}

/**
 * Update connection status UI
 */
function updateConnectionStatus(connected, deviceName = '') {
    const statusEl = document.getElementById('connectionStatus');
    if (connected) {
        statusEl.className = 'status-badge status-connected';
        statusEl.textContent = '🟢 Connected' + (deviceName ? ': ' + deviceName : '');
    } else {
        statusEl.className = 'status-badge status-disconnected';
        statusEl.textContent = '🔴 Disconnected';
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
        logReceived('⏱️ Manual mode stopped (time elapsed)');
    }
}

/**
 * Send VibeCue command
 * @param {string} command - Command without $ prefix (e.g., "DM:STATUS:REQ")
 */
async function sendCommand(command) {
    if (!isConnected || !writeCharacteristic) {
        alert('Not connected! Please connect to a device first.');
        return;
    }

    try {
        // Build payload with VibeCue format
        const payload = `$${command}`;
        const packet = buildPacket(payload);

        if (!packet) {
            alert('Failed to build packet (payload too long?)');
            return;
        }

        // Send via BLE
        await writeCharacteristic.writeValue(packet);

        // Log
        const timestamp = new Date().toLocaleTimeString();
        logSent(`[${timestamp}] ${payload}`);
        logSent(`  → Packet: ${arrayToHex(packet)}`);

    } catch (error) {
        console.error('Send failed:', error);
        alert('Send failed: ' + error.message);
        logSent('[ERROR] Send failed: ' + error.message);
    }
}

/**
 * Send device type command
 */
function sendDeviceType() {
    const type = document.querySelector('input[name="deviceType"]:checked')?.value;
    if (!type) {
        alert('Please select a device type');
        return;
    }
    sendCommand(`DM:TYPE:${type}`);
}

/**
 * Send manual START command with all parameters
 * Format: MAN:START:Freq,Level,Minutes,Loc1[,Loc2,...]
 */
function sendManualStart() {
    const freq = document.getElementById('manFreq').value;
    const intensity = document.getElementById('manIntensity').value;
    const duration = document.getElementById('manDuration').value;

    if (!freq || !intensity || !duration) {
        alert('주파수, 강도, 시간을 입력해주세요');
        return;
    }

    const checkboxes = document.querySelectorAll('.checkbox-grid input[type="checkbox"]:checked');
    const locations = Array.from(checkboxes).map(cb => cb.value).join(',');

    if (!locations) {
        alert('위치를 선택해주세요');
        return;
    }

    // Combined format: MAN:START:Freq,Level,Minutes,Loc1,Loc2,...
    sendCommand(`MAN:START:${freq},${intensity},${duration},${locations}`);
}

/**
 * Send connect device command
 */
function sendConnectDevice() {
    const mac = document.getElementById('connMac').value.trim().toUpperCase();
    const location = document.getElementById('connLocation').value;

    if (!mac) {
        alert('Please enter MAC address');
        return;
    }

    // Remove any colons or dashes from MAC
    const cleanMac = mac.replace(/[:-]/g, '');

    if (cleanMac.length !== 12 || !/^[0-9A-F]+$/.test(cleanMac)) {
        alert('Invalid MAC address. Use format: 5CF286477359 or 5C:F2:86:47:73:59');
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
        container.innerHTML = '<span style="color: #888;">No scan results yet. Click SCAN:INIT then SCAN:START.</span>';
        return;
    }

    let html = '';
    scanResults.forEach(r => {
        const signalIcon = r.rssi > -70 ? '📶' : (r.rssi > -85 ? '📶' : '📶');
        html += `<div onclick="selectScanResult('${r.mac}')" style="cursor: pointer; padding: 5px; border-bottom: 1px solid #eee; hover: background: #f0f0f0;">
            <span style="color: #667eea; font-weight: bold;">${r.mac}</span>
            <span style="color: #888; margin-left: 10px;">${r.name}</span>
            <span style="color: ${r.rssi > -70 ? '#27ae60' : (r.rssi > -85 ? '#f39c12' : '#e74c3c')}; margin-left: 10px;">${r.rssi} dBm</span>
        </div>`;
    });

    container.innerHTML = html;
}

/**
 * Select scan result and fill MAC field
 */
function selectScanResult(mac) {
    document.getElementById('connMac').value = mac;
}

/**
 * Send custom command
 */
function sendCustomCommand() {
    const cmd = document.getElementById('customCmd').value.trim();
    if (!cmd) {
        alert('Please enter a command');
        return;
    }
    sendCommand(cmd);
}

/**
 * Update device status display
 */
function updateDeviceStatus(message) {
    const statusEl = document.getElementById('deviceStatus');

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
 * Type 1,2,4 (Foot): #EVAL:STOP:STOP_OK:{L_avg_dist},{R_avg_dist},{L_avg_speed},{R_avg_speed},{asymmetry} (5 values)
 * Type 3 (Back): #EVAL:STOP:STOP_OK:{L_avg_tilt},{R_avg_tilt},{asymmetry} (3 values)
 */
function handleEvalStopData(message) {
    // Extract data part after #EVAL:STOP:STOP_OK:
    const dataMatch = message.match(/#EVAL:STOP:STOP_OK:(.+)/);
    if (!dataMatch) {
        console.warn('Failed to parse EVAL STOP data:', message);
        return;
    }

    const parts = dataMatch[1].split(',').map(s => parseInt(s.trim()));
    const timestamp = new Date().toLocaleTimeString();

    if (parts.length === 5) {
        // Type 1, 2, 4: Foot sensors average (L_dist, R_dist, L_speed, R_speed, asymmetry)
        evalDataRows.push({
            type: 'foot',
            time: timestamp,
            lDist: parts[0],
            rDist: parts[1],
            lSpeed: parts[2],
            rSpeed: parts[3],
            asymmetry: parts[4]
        });
    } else if (parts.length === 3) {
        // Type 3: Back sensor average (L_tilt, R_tilt, asymmetry)
        evalDataRows.push({
            type: 'back',
            time: timestamp,
            lTilt: parts[0],
            rTilt: parts[1],
            asymmetry: parts[2]
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

    // Clear existing rows
    tbody.innerHTML = '';

    // Add data rows (show last 20)
    const displayRows = evalDataRows.slice(-20);

    if (displayRows.length === 0) return;

    // Check data type and update header (shows average data from EVAL:STOP)
    const dataType = displayRows[0].type;
    if (dataType === 'foot') {
        thead.innerHTML = '<tr><th>Time</th><th>L Avg Dist(cm)</th><th>R Avg Dist(cm)</th><th>L Avg Spd(cm/s)</th><th>R Avg Spd(cm/s)</th><th>Asym(%)</th></tr>';
        displayRows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${row.time}</td>
                <td>${row.lDist}</td>
                <td>${row.rDist}</td>
                <td>${row.lSpeed}</td>
                <td>${row.rSpeed}</td>
                <td>${row.asymmetry}</td>
            `;
            tbody.appendChild(tr);
        });
    } else if (dataType === 'back') {
        thead.innerHTML = '<tr><th>Time</th><th>L Avg Tilt(°)</th><th>R Avg Tilt(°)</th><th>Asym(%)</th></tr>';
        displayRows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${row.time}</td>
                <td>${row.lTilt}</td>
                <td>${row.rTilt}</td>
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
    evalDataRows = [];
    updateEvalTable();
    logSent('📊 EVAL data cleared');
}

/**
 * Download EVAL data as CSV
 */
function downloadEvalData() {
    if (evalDataRows.length === 0) {
        alert('No data to download');
        return;
    }

    // Build CSV based on data type (average data from EVAL:STOP)
    let csv = '';
    const dataType = evalDataRows[0].type;

    if (dataType === 'foot') {
        csv = 'Time,L_Avg_Dist(cm),R_Avg_Dist(cm),L_Avg_Speed(cm/s),R_Avg_Speed(cm/s),Asymmetry(%)\n';
        evalDataRows.forEach(row => {
            csv += `${row.time},${row.lDist},${row.rDist},${row.lSpeed},${row.rSpeed},${row.asymmetry}\n`;
        });
    } else if (dataType === 'back') {
        csv = 'Time,L_Avg_Tilt(deg),R_Avg_Tilt(deg),Asymmetry(%)\n';
        evalDataRows.forEach(row => {
            csv += `${row.time},${row.lTilt},${row.rTilt},${row.asymmetry}\n`;
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
    console.log('VibeCue Protocol Tester v2.0 loaded');

    // Check for Web Bluetooth API support
    if (!navigator.bluetooth) {
        alert('⚠️ Web Bluetooth API is not supported in this browser.\n\nPlease use Chrome, Edge, or Opera on desktop/Android.');
        document.getElementById('connectBtn').disabled = true;
    }

    logSent('🚀 VibeCue Tester v2.0 initialized');
    logSent('📱 Ready to connect...');
});

// Handle disconnection
window.addEventListener('beforeunload', () => {
    if (isConnected) {
        disconnectBluetooth();
    }
});
