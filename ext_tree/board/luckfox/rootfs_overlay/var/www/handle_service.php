<?php
require_once 'audio_transition.php';

header('Content-Type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', 1);

function logMessage($message) {
    error_log("[Player Manager] " . $message);
}

function executeCommand($command) {
    logMessage("Executing: $command");
    $command = 'PUREFOX_AUDIO_LOCK_HELD=1 ' . $command;
    $output = shell_exec("/usr/bin/sudo /bin/sh -c " . escapeshellarg($command) . " 2>&1");
    logMessage("Output: " . trim((string)$output));
    return trim((string)$output);
}

function fail($message) {
    logMessage("Error: $message");
    echo json_encode(['status' => 'error', 'message' => $message]);
    exit;
}

function stopProcessGroup($processList) {
    $plist = implode(' ', array_map('escapeshellarg', $processList));
    executeCommand("killall $plist 2>/dev/null || true");
    executeCommand("sleep 0.1");
    executeCommand("killall -9 $plist 2>/dev/null || true");
}

function waitForProcess($process, $timeoutMs = 1000, $pidFile = null) {
    $attempts = (int)($timeoutMs / 100);
    for ($attempt = 0; $attempt < $attempts; $attempt++) {
        if ($pidFile && is_readable($pidFile)) {
            $pid = trim((string)file_get_contents($pidFile));
            if ($pid !== '' && strspn($pid, '0123456789') === strlen($pid) && (int)$pid > 0 &&
                trim((string)shell_exec('kill -0 ' . (int)$pid . ' 2>/dev/null && echo alive')) === 'alive') {
                return true;
            }
        }
        $pid = trim((string)shell_exec('/bin/pidof ' . escapeshellarg($process) . ' 2>/dev/null'));
        if ($pid !== '') {
            return true;
        }
        usleep(100000);
    }
    return false;
}

$players = [
    'naa'        => ['process' => 'networkaudiod',   'script' => 'S95naa'],
    'raat'       => ['process' => 'raat_app',        'script' => 'S95roonready'],
    'mpd'        => ['process' => 'mpd',             'script' => 'S95mpd'],
    'aprenderer' => ['process' => 'ap2renderer',     'script' => 'S95aprenderer'],
    'aplayer'    => ['process' => 'aplayer',         'script' => 'S95aplayer'],
    'apscream'   => ['process' => 'apscream',        'script' => 'S95apscream'],
    'scream'     => ['process' => 'scream',          'script' => 'S95scream'],
    'shairport'  => ['process' => 'shairport-sync',  'script' => 'S95shairport'],
    'lms'        => ['process' => 'squeezelite',     'script' => 'S95squeezelite'],
    'spotify'    => ['process' => 'librespot',       'script' => 'S95spotify'],
    'qobuz'      => ['process' => 'qobuz-connect',   'script' => 'S95qobuz'],
    // Linux limits the process comm field to 15 characters.  BusyBox pidof
    // and killall therefore see celmusper-transport as celmusper-trans.
    'celmusper'  => ['process' => 'celmusper-trans', 'script' => 'S95celmusper', 'pidfile' => '/tmp/celmusper-transport.pid'],
];

if (file_exists('/opt/tidal.sqfs')) {
    $players['tidalconnect'] = ['process' => 'tidalconnect', 'script' => 'S95tidal'];
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail("Invalid request method");
}

$playerToStart = $_POST['service'] ?? '';
if (!isset($players[$playerToStart])) {
    fail("Invalid player: $playerToStart");
}

$scriptPath = "/etc/rc.pure/{$players[$playerToStart]['script']}";
if (!file_exists($scriptPath)) {
    fail("Player script not found: $scriptPath");
}

$lockFp = acquireAudioTransitionLock();
if (!$lockFp) {
    fail("Audio transition already in progress");
}

try {
    logMessage("Request to start player: $playerToStart");

    if (file_exists('/etc/usb_to_i2s.state')) {
        executeCommand('/opt/usb_unlock.sh');
    }

    // Stop previously active managed player if present
    executeCommand('[ -x /etc/init.d/S95player ] && /etc/init.d/S95player stop || true');

    // Hard-stop all known player processes (fallback)
    stopProcessGroup(['networkaudiod', 'raat_app', 'mpd', 'upmpdcli', 'ap2renderer', 'aplayer', 'apscream', 'scream', 'shairport-sync', 'squeezelite', 'librespot', 'qobuz-connect', 'celmusper-trans', 'tidalconnect', 'tc_volume', 'avahi-publish-service']);

    // Create one stable managed symlink, do not touch other S95 services
    executeCommand('rm -f /etc/init.d/S95player');
    executeCommand('ln -s ' . escapeshellarg($scriptPath) . ' /etc/init.d/S95player');

    // Start selected player in foreground of this shell call (script itself backgrounds daemons as needed)
    $startOutput = executeCommand('/etc/init.d/S95player start');

    // Publish the transition immediately. status_monitor verifies the actual
    // process state and pushes it to connected browsers through SSE.
    executeCommand('/opt/dbus_notify ServiceChanged ' . escapeshellarg($playerToStart) . ' 2>/dev/null || true');

    // Confirm the actual process without a fixed one-second delay.
    $proc = $players[$playerToStart]['process'];
    $confirmed = waitForProcess($proc, 1000, $players[$playerToStart]['pidfile'] ?? null);

    echo json_encode([
        'status' => $confirmed ? 'success' : 'error',
        'message' => $confirmed ? "Switched to $playerToStart" : "Failed to start $playerToStart",
        'confirmed' => $confirmed,
        'output' => $startOutput
    ]);
} finally {
    releaseAudioTransitionLock($lockFp);
}
?>
