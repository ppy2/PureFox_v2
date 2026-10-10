<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

// CORRECT JSON reading from C-monitor
$status_file = '/tmp/system_status.json';

// First try to read file from C-monitor
if (file_exists($status_file)) {
    $age = time() - filemtime($status_file);
    
    // Allow cache to be up to 60 seconds old
    if ($age < 60) {
        $content = file_get_contents($status_file);
        if ($content) {
            $decoded = json_decode($content, true);
            if ($decoded && is_array($decoded)) {
                // Check that all required fields are present
                $has_fields = isset($decoded['active_service'], $decoded['alsa_state'], $decoded['usb_dac'], $decoded['volume'], $decoded['muted']);
                if (!$has_fields) {
                    error_log("status_fast.php: Missing fields in JSON: " . print_r($decoded, true));
                }
                if ($has_fields) {
                    $boot_id = trim((string) @file_get_contents('/proc/sys/kernel/random/boot_id'));
                    if ($boot_id !== '') {
                        $decoded['boot_id'] = $boot_id;
                    }

                    // TidalConnect check moved to status_monitor.c for better performance
                    
                    // Override control availability for USB mode without physical DAC
                    if ($decoded['alsa_state'] === 'usb' && !$decoded['usb_dac']) {
                        // USB mode but no physical USB DAC - disable controls
                        $decoded['volume'] = '100%';
                        $decoded['volume_control_available'] = false;
                        $decoded['mute_control_available'] = false;
                        $decoded['muted'] = false;
                    }
                    
                    // Set defaults for control availability if not provided by C-monitor
                    if (!isset($decoded['volume_control_available'])) {
                        $decoded['volume_control_available'] = true;
                        $decoded['mute_control_available'] = true;
                    }
                    
                    // Add marker that data is from C-monitor
                    $decoded['source'] = 'c_monitor';
                    echo json_encode($decoded);
                    exit;
                }
            }
        }
    }
}

// Fallback - if C-monitor not working, use old PHP approach
$services = [
    'naa'         => 'networkaudiod',
    'raat'        => 'raat_app',
    'mpd'         => 'mpd', 
    'squeeze2upn' => 'squeeze2upnp',
    'aprenderer'  => 'ap2renderer',
    'aplayer'     => 'aplayer',
    'apscream'    => 'apscream',
    'scream'      => 'scream',
    'lms'         => 'squeezelite',
    'shairport'   => 'shairport-sync',
    'spotify'     => 'librespot',
    'qobuz'       => 'qobuz-connect',
    'celmusper'   => 'celmusper-trans',
    'tidalconnect'=> 'tidalconnect',
];

$status = [
    'active_service' => '',
    'alsa_state' => 'unknown',
    'usb_dac' => false,
    'volume' => '100%',
    'muted' => false,
    'source' => 'php_fallback'
];

function findUsbDacCard() {
    foreach (glob('/sys/class/sound/card*/device') as $devicePath) {
        $resolvedPath = realpath($devicePath);
        if ($resolvedPath === false || strpos($resolvedPath, '/usb') === false) {
            continue;
        }

        $cardName = basename(dirname($devicePath));
        return ctype_digit(substr($cardName, 4)) ? (int)substr($cardName, 4) : null;
    }

    return null;
}

$boot_id = trim((string) @file_get_contents('/proc/sys/kernel/random/boot_id'));
if ($boot_id !== '') {
    $status['boot_id'] = $boot_id;
}

// Determine active service
$all_processes = implode('|', array_values($services));
$output = shell_exec("ps -eo comm | grep -E '^($all_processes)$' | head -1");

if (!empty($output)) {
    $found_process = trim($output);
    foreach ($services as $key => $process) {
        if ($found_process === $process) {
            $status['active_service'] = $key;
            break;
        }
    }
}

// ALSA state check
$output_file = '/etc/output';
if (file_exists($output_file)) {
    $output_content = trim(file_get_contents($output_file));
    if (strtoupper($output_content) === 'USB') {
        $status['alsa_state'] = 'usb';
    } elseif (strtoupper($output_content) === 'I2S') {
        $status['alsa_state'] = 'i2s';
    }
}

// USB DAC check
$usb_card_number = findUsbDacCard();
$status['usb_dac'] = $usb_card_number !== null;

// Get volume - try available controls
// Determine which card to check based on ALSA state and physical USB DAC presence
$card_number = ($status['alsa_state'] === 'usb' && $status['usb_dac']) ? $usb_card_number : 0;

$volume_controls = ['PCM', 'Master'];

// Get available controls and try them on the active card
exec('/usr/bin/amixer -c ' . $card_number . ' scontrols 2>/dev/null', $controls_output, $controls_code);
if ($controls_code === 0 && !empty($controls_output)) {
    foreach ($controls_output as $control_line) {
        if (preg_match("/Simple mixer control '([^']+)',/", $control_line, $control_matches)) {
            $control_name = $control_matches[1];
            // Case-insensitive search for volume-related keywords (NOT switch - that's mute)
            $name_lower = strtolower($control_name);
            if (strpos($name_lower, 'volume') !== false || 
                strpos($name_lower, 'playback') !== false ||
                strpos($name_lower, 'master') !== false ||
                strpos($name_lower, 'speaker') !== false ||
                strpos($name_lower, 'headphone') !== false ||
                strpos($name_lower, 'dac') !== false ||
                !in_array($control_name, $volume_controls)) {
                $volume_controls[] = $control_name;
            }
        }
    }
} else {
    // No simple controls available - this is a USB DAC without mixer controls
    $volume_controls = [];
}

$volume_found = false;
$mute_found = false;
$fallback_50_percent_control = null;

// If no controls available, skip the loop
if (empty($volume_controls)) {
    $volume_found = false;
    $mute_found = false;
} else {
    foreach ($volume_controls as $control) {
        exec('/usr/bin/amixer -c ' . $card_number . ' sget "' . $control . '" 2>/dev/null', $volume_output, $volume_code);
        if ($volume_code === 0 && !empty($volume_output)) {
            $volume_line = implode(' ', $volume_output);
            
            if (preg_match('/\[(\d+)%\]/', $volume_line, $volume_matches)) {
                $volume_percent = intval($volume_matches[1]);
                
                // Skip controls that show exactly 50% (likely non-functional)
                if ($volume_percent == 50) {
                    $fallback_50_percent_control = $control;
                    // Don't break, keep looking for a real control
                } else {
                    $status['volume'] = $volume_percent . '%';
                    $volume_found = true;
                }
            }
            
            // Check mute state (separate from volume)
            if (strpos($volume_line, '[off]') !== false || strpos($volume_line, '[on]') !== false) {
                $status['muted'] = (strpos($volume_line, '[off]') !== false);
                $mute_found = true;
            }
            
            if ($volume_found) break;
        }
    }
}

// Check control availability  
if ($status['alsa_state'] === 'usb' && !$status['usb_dac']) {
    // USB mode but no physical USB DAC - disable controls
    $status['volume'] = '100%';
    $status['volume_control_available'] = false;
    $status['mute_control_available'] = false;
    $status['muted'] = false;
} elseif (empty($volume_controls) && $status['usb_dac'] && $status['alsa_state'] === 'usb') {
    // No mixer controls at all - typical for USB DACs without hardware volume
    $status['volume'] = '100%';
    $status['volume_control_available'] = false;
    $status['mute_control_available'] = false;
    $status['muted'] = false;
} elseif (!$volume_found && $fallback_50_percent_control && $status['usb_dac'] && $status['alsa_state'] === 'usb') {
    // Only 50% controls found - likely non-functional
    $status['volume'] = '100%';
    $status['volume_control_available'] = false;
    $status['mute_control_available'] = false;
    $status['muted'] = false;
} else {
    $status['volume_control_available'] = $volume_found;
    $status['mute_control_available'] = $mute_found;
}

echo json_encode($status);
?>
