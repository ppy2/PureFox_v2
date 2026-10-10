#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/stat.h>
#include <time.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <dirent.h>
#include <ctype.h>
#include <errno.h>
#include <stdbool.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <alsa/asoundlib.h>
#include <dbus/dbus.h>

#define STATUS_FILE "/tmp/system_status.json"
#define MIXER_CACHE_FILE "/tmp/mixer_control_cache"
#define LOCK_FILE "/tmp/status_monitor.lock"
#define DBUS_SERVICE_NAME "org.purefox.statusmonitor"
#define DBUS_OBJECT_PATH "/org/purefox/statusmonitor"
#define DBUS_INTERFACE_NAME "org.purefox.StatusMonitor"
#define EVENT_SOCKET "/tmp/status_monitor_events.sock"
#define EVENT_CLIENTS_MAX 4
#define STATUS_POLL_MAX (EVENT_CLIENTS_MAX + 10)
#define VOLUME_SAVE_DELAY_MS 1000

volatile int running = 1;
DBusConnection *dbus_conn = NULL;
static int event_server = -1;
static int event_clients[EVENT_CLIENTS_MAX] = { -1, -1, -1, -1 };
static char status_json[512];
static char boot_id[40];
static snd_mixer_t *volume_event_mixer;
static int pending_volume_persist = -1;
static long long volume_persist_at;
static pid_t active_service_pid;
static long long last_service_discovery;

void update_status_file(void);

static void read_boot_id(void)
{
    FILE *fp;

    fp = fopen("/proc/sys/kernel/random/boot_id", "r");
    if (!fp)
        return;
    if (fgets(boot_id, sizeof(boot_id), fp))
        boot_id[strcspn(boot_id, "\r\n")] = '\0';
    fclose(fp);
}

void signal_handler(int sig) {
    running = 0;
}

static void close_event_client(int index)
{
    close(event_clients[index]);
    event_clients[index] = -1;
}

static void publish_status(void)
{
    int i;

    for (i = 0; i < EVENT_CLIENTS_MAX; i++) {
        ssize_t written;

        if (event_clients[i] < 0)
            continue;
        written = send(event_clients[i], status_json, strlen(status_json), MSG_NOSIGNAL);
        if (written != (ssize_t)strlen(status_json))
            close_event_client(i);
    }
}

static int init_event_server(void)
{
    struct sockaddr_un address;
    int flags;

    event_server = socket(AF_UNIX, SOCK_STREAM, 0);
    if (event_server < 0)
        return -1;
    flags = fcntl(event_server, F_GETFL, 0);
    if (flags < 0 || fcntl(event_server, F_SETFL, flags | O_NONBLOCK) < 0)
        goto error;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    strncpy(address.sun_path, EVENT_SOCKET, sizeof(address.sun_path) - 1);
    unlink(EVENT_SOCKET);
    if (bind(event_server, (struct sockaddr *)&address, sizeof(address)) < 0)
        goto error;
    if (chmod(EVENT_SOCKET, 0666) < 0 || listen(event_server, EVENT_CLIENTS_MAX) < 0)
        goto error;
    return 0;

error:
    close(event_server);
    event_server = -1;
    unlink(EVENT_SOCKET);
    return -1;
}

static void service_event_clients(void)
{
    int i, flags;

    if (event_server >= 0) {
        for (;;) {
            int client = accept(event_server, NULL, NULL);

            if (client < 0) {
                if (errno != EAGAIN && errno != EWOULDBLOCK)
                    perror("status event accept");
                break;
            }
            flags = fcntl(client, F_GETFL, 0);
            if (flags < 0 || fcntl(client, F_SETFL, flags | O_NONBLOCK) < 0) {
                close(client);
                continue;
            }
            for (i = 0; i < EVENT_CLIENTS_MAX; i++) {
                if (event_clients[i] < 0) {
                    event_clients[i] = client;
                    if (status_json[0] &&
                        send(client, status_json, strlen(status_json), MSG_NOSIGNAL) !=
                            (ssize_t)strlen(status_json))
                        close_event_client(i);
                    last_service_discovery = 0;
                    break;
                }
            }
            if (i == EVENT_CLIENTS_MAX)
                close(client);
        }
    }
    for (i = 0; i < EVENT_CLIENTS_MAX; i++) {
        struct pollfd client_poll = { .fd = event_clients[i], .events = 0 };

        if (event_clients[i] >= 0 && poll(&client_poll, 1, 0) > 0 &&
            (client_poll.revents & (POLLERR | POLLHUP | POLLNVAL)))
            close_event_client(i);
    }
}

static bool have_event_clients(void)
{
    int i;

    for (i = 0; i < EVENT_CLIENTS_MAX; i++) {
        if (event_clients[i] >= 0)
            return true;
    }
    return false;
}

static long long monotonic_ms(void)
{
    struct timespec now;

    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec * 1000LL + now.tv_nsec / 1000000;
}

static void schedule_volume_persist(const char *volume)
{
    int value;

    if (sscanf(volume, "%d%%", &value) != 1 || value < 0 || value > 100)
        return;
    pending_volume_persist = value;
    volume_persist_at = monotonic_ms() + VOLUME_SAVE_DELAY_MS;
}

static void persist_pending_volume(void)
{
    FILE *file;

    if (pending_volume_persist < 0 || monotonic_ms() < volume_persist_at)
        return;
    file = fopen("/data/i2s_volume.status.tmp", "w");
    if (!file)
        return;
    fprintf(file, "%d\n", pending_volume_persist);
    fclose(file);
    if (!rename("/data/i2s_volume.status.tmp", "/data/i2s_volume"))
        pending_volume_persist = -1;
}

// Structure for storing current state
typedef struct {
    char active_service[32];
    char alsa_state[16];
    int usb_dac;
    char volume[16];
    int muted;
    int volume_control_available;
    int mute_control_available;
    char mixer_control_name[64];  // Found ALSA control name
    int mixer_control_index;      // Control index
    bool mixer_control_valid;     // Is cached control still valid
    time_t last_update;
} system_status_t;

system_status_t current_status = {
    .active_service = "",
    .alsa_state = "unknown",
    .usb_dac = 0,
    .volume = "100%",
    .muted = 0,
    .volume_control_available = 1,
    .mute_control_available = 1,
    .mixer_control_name = "",
    .mixer_control_index = 0,
    .mixer_control_valid = false,
    .last_update = 0
};

// Check active audio process through /proc
void get_active_service(char* service, pid_t *pid) {
    DIR *proc_dir;
    struct dirent *entry;
    FILE *cmdline_file;
    char path[512];
    char cmdline[1024];
    char *process_name;
    
    const char* services[][2] = {
        {"networkaudiod", "naa"},
        {"raat_app", "raat"},
        {"mpd", "mpd"},
        {"squeeze2upnp", "squeeze2upn"},
        {"ap2renderer", "aprenderer"},
        {"aplayer", "aplayer"},
        {"apscream", "apscream"},
        {"scream", "scream"},
        {"squeezelite", "lms"},
        {"shairport-sync", "shairport"},
        {"librespot", "spotify"},
        {"qobuz-connect", "qobuz"},
        {"celmusper-transport", "celmusper"},
        {"tidalconnect", "tidalconnect"},
        {NULL, NULL}
    };
    
    strcpy(service, "");
    *pid = 0;
    
    proc_dir = opendir("/proc");
    if (!proc_dir) return;
    
    while ((entry = readdir(proc_dir)) != NULL) {
        if (!isdigit(entry->d_name[0])) continue;
        if (strlen(entry->d_name) > 100) continue;
        
        snprintf(path, sizeof(path), "/proc/%s/cmdline", entry->d_name);
        cmdline_file = fopen(path, "r");
        if (!cmdline_file) continue;
        
        if (fgets(cmdline, sizeof(cmdline), cmdline_file)) {
            process_name = strrchr(cmdline, '/');
            if (process_name) {
                process_name++;
            } else {
                process_name = cmdline;
            }
            
            for (int i = 0; services[i][0]; i++) {
                if (strcmp(process_name, services[i][0]) == 0) {
                    strcpy(service, services[i][1]);
                    *pid = (pid_t)strtol(entry->d_name, NULL, 10);
                    fclose(cmdline_file);
                    closedir(proc_dir);
                    return;
                }
            }
        }
        fclose(cmdline_file);
    }
    
    closedir(proc_dir);
}

/* A running player is tracked by PID, so detecting its exit does not require
 * repeatedly walking /proc. Only an idle system is scanned for a new player. */
static void refresh_active_service_state(void)
{
    char service[sizeof(current_status.active_service)];
    pid_t pid;
    long long now;

    if (active_service_pid > 0) {
        if (kill(active_service_pid, 0) == 0 || errno == EPERM)
            return;
        if (errno != ESRCH)
            return;
    } else {
        now = monotonic_ms();
        if (now - last_service_discovery <
            (have_event_clients() ? 500 : 5000))
            return;
        last_service_discovery = now;
    }

    get_active_service(service, &pid);
    active_service_pid = pid;
    if (strcmp(service, current_status.active_service) == 0)
        return;

    strcpy(current_status.active_service, service);
    current_status.last_update = time(NULL);
    update_status_file();
}

// Check ALSA state
void get_alsa_state(char* state) {
    FILE *fp;
    char buffer[256];
    
    strcpy(state, "unknown");
    
    fp = fopen("/etc/output", "r");
    if (fp) {
        if (fgets(buffer, sizeof(buffer), fp)) {
            buffer[strcspn(buffer, "\n")] = 0;
            if (strcasecmp(buffer, "USB") == 0) {
                strcpy(state, "usb");
            } else if (strcasecmp(buffer, "I2S") == 0) {
                strcpy(state, "i2s");
            }
        }
        fclose(fp);
        return;
    }
    
    fp = fopen("/etc/asound.conf", "r");
    if (fp) {
        while (fgets(buffer, sizeof(buffer), fp)) {
            if (strstr(buffer, "card 1")) {
                strcpy(state, "usb");
                break;
            } else if (strstr(buffer, "card 0")) {
                strcpy(state, "i2s");
                break;
            }
        }
        fclose(fp);
    }
}

static int find_usb_audio_card(void)
{
    DIR *sound_dir;
    struct dirent *entry;
    char device_link[PATH_MAX];
    char device_path[PATH_MAX];
    int card = -1;

    sound_dir = opendir("/sys/class/sound");
    if (!sound_dir)
        return -1;

    while ((entry = readdir(sound_dir)) != NULL) {
        if (strncmp(entry->d_name, "card", 4) != 0 ||
            !isdigit((unsigned char)entry->d_name[4]))
            continue;

        snprintf(device_link, sizeof(device_link),
                 "/sys/class/sound/%s/device", entry->d_name);
        if (!realpath(device_link, device_path))
            continue;

        if (strstr(device_path, "/usb") != NULL) {
            card = (int)strtol(entry->d_name + 4, NULL, 10);
            break;
        }
    }

    closedir(sound_dir);
    return card;
}

// Check USB DAC
int check_usb_dac() {
    return find_usb_audio_card() >= 0;
}

// Find and cache ALSA mixer control (expensive operation, call only when DAC changes)
bool find_mixer_control() {
    snd_mixer_t *handle;
    snd_mixer_elem_t *elem;
    snd_mixer_selem_id_t *sid;
    
    strcpy(current_status.mixer_control_name, "");
    current_status.mixer_control_index = 0;
    current_status.mixer_control_valid = false;
    
    if (snd_mixer_open(&handle, 0) < 0) return false;
    if (snd_mixer_attach(handle, "default") < 0) {
        snd_mixer_close(handle);
        return false;
    }
    if (snd_mixer_selem_register(handle, NULL, NULL) < 0) {
        snd_mixer_close(handle);
        return false;
    }
    if (snd_mixer_load(handle) < 0) {
        snd_mixer_close(handle);
        return false;
    }
    
    elem = NULL;
    
    const char* standard_names[] = {
        "PCM", "Speaker", "Master", "Headphone", "Digital", 
        "Playback", "DAC", "Line Out", "Analog", "Output",
        "Front", "Main", "Volume", NULL
    };
    
    for (int i = 0; standard_names[i] != NULL && !elem; i++) {
        snd_mixer_selem_id_alloca(&sid);
        snd_mixer_selem_id_set_name(sid, standard_names[i]);
        snd_mixer_elem_t* test_elem = snd_mixer_find_selem(handle, sid);
        
        if (test_elem && snd_mixer_selem_has_playback_volume(test_elem)) {
            elem = test_elem;
        }
    }
    
    if (!elem) {
        for (elem = snd_mixer_first_elem(handle); elem; elem = snd_mixer_elem_next(elem)) {
            if (snd_mixer_selem_is_active(elem)) {
                const char *name = snd_mixer_selem_get_name(elem);
                bool has_vol = snd_mixer_selem_has_playback_volume(elem);
                
                if (has_vol && name) {
                    if (strstr(name, "Capture") || strstr(name, "Mic")) {
                        continue;
                    }
                    
                    bool has_valid_channels = snd_mixer_selem_has_playback_channel(elem, SND_MIXER_SCHN_FRONT_LEFT) ||
                                            snd_mixer_selem_has_playback_channel(elem, SND_MIXER_SCHN_MONO);
                    
                    if (has_valid_channels) {
                        break;
                    }
                }
            }
        }
    }
    
    if (elem) {
        const char *control_name = snd_mixer_selem_get_name(elem);
        if (control_name) {
            strncpy(current_status.mixer_control_name, control_name, sizeof(current_status.mixer_control_name) - 1);
            current_status.mixer_control_name[sizeof(current_status.mixer_control_name) - 1] = '\0';
            current_status.mixer_control_index = snd_mixer_selem_get_index(elem);
            current_status.mixer_control_valid = true;
            
            printf("Found mixer control: '%s',%d\n", 
                   current_status.mixer_control_name, 
                   current_status.mixer_control_index);
        }
    }
    
    snd_mixer_close(handle);
    return current_status.mixer_control_valid;
}

// ALSA API for reading volume (uses cached control)
void get_volume_status_alsa(char* volume, int* muted) {
    snd_mixer_t *handle;
    snd_mixer_elem_t *elem;
    snd_mixer_selem_id_t *sid;
    long min, max, val;
    long db_min, db_max, db_value;
    double normalized, min_normalized;
    int switch_val;
    snd_mixer_selem_channel_id_t volume_channel = SND_MIXER_SCHN_FRONT_LEFT;
    
    strcpy(volume, "100%");
    *muted = 0;
    
    // If no valid cached control, try to find it
    if (!current_status.mixer_control_valid) {
        if (!find_mixer_control()) {
            return;
        }
    }
    
    if (snd_mixer_open(&handle, 0) < 0) return;
    if (snd_mixer_attach(handle, "default") < 0) {
        snd_mixer_close(handle);
        return;
    }
    if (snd_mixer_selem_register(handle, NULL, NULL) < 0) {
        snd_mixer_close(handle);
        return;
    }
    if (snd_mixer_load(handle) < 0) {
        snd_mixer_close(handle);
        return;
    }
    
    // Use cached control name
    snd_mixer_selem_id_alloca(&sid);
    snd_mixer_selem_id_set_name(sid, current_status.mixer_control_name);
    snd_mixer_selem_id_set_index(sid, current_status.mixer_control_index);
    elem = snd_mixer_find_selem(handle, sid);
    
    if (!elem) {
        // Cached control not found - invalidate cache and retry
        printf("Cached control '%s',%d not found, invalidating cache\n",
               current_status.mixer_control_name, current_status.mixer_control_index);
        current_status.mixer_control_valid = false;
        snd_mixer_close(handle);
        return;
    }
    
    if (snd_mixer_selem_has_playback_volume(elem)) {
        snd_mixer_selem_get_playback_volume_range(elem, &min, &max);
        
        int read_success = 0;
        
        if (snd_mixer_selem_get_playback_volume(elem, SND_MIXER_SCHN_FRONT_LEFT, &val) >= 0)
            read_success = 1;
        
        if (!read_success &&
            snd_mixer_selem_get_playback_volume(elem, SND_MIXER_SCHN_FRONT_RIGHT, &val) >= 0) {
            read_success = 1;
            volume_channel = SND_MIXER_SCHN_FRONT_RIGHT;
        }

        if (!read_success &&
            snd_mixer_selem_get_playback_volume(elem, SND_MIXER_SCHN_MONO, &val) >= 0) {
            read_success = 1;
            volume_channel = SND_MIXER_SCHN_MONO;
        }
        
        if (read_success &&
            snd_mixer_selem_get_playback_dB_range(elem, &db_min, &db_max) >= 0 &&
            db_min < db_max &&
            snd_mixer_selem_get_playback_dB(elem, volume_channel, &db_value) >= 0) {
            if (db_max - db_min <= 2400) {
                normalized = (double)(db_value - db_min) / (db_max - db_min);
            } else {
                normalized = pow(10.0, (double)(db_value - db_max) / 6000.0);
                min_normalized = pow(10.0, (double)(db_min - db_max) / 6000.0);
                normalized = (normalized - min_normalized) / (1.0 - min_normalized);
            }
            snprintf(volume, 16, "%d%%", (int)lround(normalized * 100.0));
        } else if (read_success && max > min) {
            int percent = (int)(((val - min) * 100 + (max - min) / 2) /
                                (max - min));
            snprintf(volume, 16, "%d%%", percent);
        }
    }
    
    if (snd_mixer_selem_has_playback_switch(elem)) {
        if (snd_mixer_selem_get_playback_switch(elem, SND_MIXER_SCHN_FRONT_LEFT,
                                                 &switch_val) >= 0)
            *muted = !switch_val;
        else if (snd_mixer_selem_get_playback_switch(elem, SND_MIXER_SCHN_FRONT_RIGHT,
                                                      &switch_val) >= 0)
            *muted = !switch_val;
        else if (snd_mixer_selem_get_playback_switch(elem, SND_MIXER_SCHN_MONO,
                                                      &switch_val) >= 0)
            *muted = !switch_val;
    }
    
    snd_mixer_close(handle);
}

static void reset_volume_event_mixer(void)
{
    if (volume_event_mixer) {
        snd_mixer_close(volume_event_mixer);
        volume_event_mixer = NULL;
    }
}

static bool init_volume_event_mixer(void)
{
    if (volume_event_mixer)
        return true;
    if (snd_mixer_open(&volume_event_mixer, 0) < 0)
        return false;
    if (snd_mixer_attach(volume_event_mixer, "default") < 0 ||
        snd_mixer_selem_register(volume_event_mixer, NULL, NULL) < 0 ||
        snd_mixer_load(volume_event_mixer) < 0) {
        reset_volume_event_mixer();
        return false;
    }
    return true;
}

static bool wait_for_volume_event(int timeout_ms)
{
    int ret;

    if (!init_volume_event_mixer())
        return false;
    ret = snd_mixer_wait(volume_event_mixer, timeout_ms);
    if (ret <= 0) {
        if (ret < 0)
            reset_volume_event_mixer();
        return false;
    }
    if (snd_mixer_handle_events(volume_event_mixer) < 0) {
        reset_volume_event_mixer();
        return false;
    }
    return true;
}

/* Wait for every source that can change published status without polling. */
static bool poll_status_events(int timeout_ms)
{
    struct pollfd fds[STATUS_POLL_MAX];
    int count = 0, dbus_index = -1, mixer_index = -1, mixer_count = 0;
    int i, ret;
    bool volume_event = false;

    if (dbus_conn) {
        int fd;

        if (dbus_connection_get_unix_fd(dbus_conn, &fd)) {
            dbus_index = count;
            fds[count++] = (struct pollfd){ .fd = fd, .events = POLLIN };
        }
    }
    if (event_server >= 0)
        fds[count++] = (struct pollfd){ .fd = event_server, .events = POLLIN };
    for (i = 0; i < EVENT_CLIENTS_MAX && count < STATUS_POLL_MAX; i++) {
        if (event_clients[i] >= 0)
            fds[count++] = (struct pollfd){ .fd = event_clients[i], .events = POLLIN };
    }

    if (init_volume_event_mixer()) {
        mixer_count = snd_mixer_poll_descriptors_count(volume_event_mixer);
        if (mixer_count > 0 && count + mixer_count <= STATUS_POLL_MAX) {
            mixer_index = count;
            if (snd_mixer_poll_descriptors(volume_event_mixer, &fds[count],
                                           mixer_count) < 0) {
                reset_volume_event_mixer();
                mixer_index = -1;
            } else {
                count += mixer_count;
            }
        }
    }

    ret = poll(fds, count, timeout_ms);
    if (ret <= 0)
        return false;

    if (dbus_index >= 0 && fds[dbus_index].revents)
        dbus_connection_read_write_dispatch(dbus_conn, 0);

    if (mixer_index >= 0) {
        unsigned short revents = 0;

        /* A USB DAC may disappear while its control fd is in poll().  The
         * stale fd then stays readable/error-ready forever; keeping it turns
         * this loop into a 100% CPU spin until ALSA eventually recovers. */
        if (fds[mixer_index].revents & (POLLERR | POLLHUP | POLLNVAL) ||
            snd_mixer_poll_descriptors_revents(volume_event_mixer,
                                               &fds[mixer_index], mixer_count,
                                               &revents) < 0) {
            reset_volume_event_mixer();
        } else if (revents) {
            if (snd_mixer_handle_events(volume_event_mixer) < 0)
                reset_volume_event_mixer();
            else
                volume_event = true;
        }
    }
    service_event_clients();
    return volume_event;
}

static int status_poll_timeout(long long last_volume_poll)
{
    long long now = monotonic_ms();
    long long next_poll = last_volume_poll +
        (have_event_clients() ? 250 : 1000);
    long long deadline = next_poll;

    if (pending_volume_persist >= 0 && volume_persist_at < deadline)
        deadline = volume_persist_at;
    if (deadline <= now)
        return 0;
    return (int)(deadline - now);
}

static void refresh_volume_status_if_changed(time_t now)
{
    char old_volume[16];
    int old_muted = current_status.muted;
    bool volume_changed;

    strcpy(old_volume, current_status.volume);
    get_volume_status_alsa(current_status.volume, &current_status.muted);
    volume_changed = strcmp(old_volume, current_status.volume) != 0;
    if (volume_changed || old_muted != current_status.muted) {
        printf("Volume changed: %s (muted: %s)\n", current_status.volume,
               current_status.muted ? "yes" : "no");
        current_status.last_update = now;
        update_status_file();
    }
    if (volume_changed)
        schedule_volume_persist(current_status.volume);
}

static bool get_dbus_volume(DBusMessage *message, int *volume)
{
    DBusMessageIter args;
    const char *value;
    char *end;
    long parsed;

    if (!dbus_message_iter_init(message, &args) ||
        dbus_message_iter_get_arg_type(&args) != DBUS_TYPE_STRING)
        return false;
    dbus_message_iter_get_basic(&args, &value);
    parsed = strtol(value, &end, 10);
    if (end == value || strcmp(end, "%") || parsed < 0 || parsed > 100)
        return false;
    *volume = (int)parsed;
    return true;
}

// Check USB DAC control availability using ALSA API
void check_usb_controls(int* volume_available, int* mute_available) {
    *volume_available = 0;
    *mute_available = 0;
    int usb_card = find_usb_audio_card();
    char device_name[16];
    snd_mixer_t *mixer = NULL;
    snd_mixer_elem_t *elem;

    if (usb_card < 0)
        return;
    snprintf(device_name, sizeof(device_name), "hw:%d", usb_card);

    if (snd_mixer_open(&mixer, 0) >= 0) {
        if (snd_mixer_attach(mixer, device_name) >= 0) {
            if (snd_mixer_selem_register(mixer, NULL, NULL) >= 0) {
                if (snd_mixer_load(mixer) >= 0) {
                    for (elem = snd_mixer_first_elem(mixer); elem; elem = snd_mixer_elem_next(elem)) {
                        if (snd_mixer_selem_is_active(elem)) {
                            const char *name = snd_mixer_selem_get_name(elem);
                            
                            if (name && (strstr(name, "Capture") || strstr(name, "Mic"))) {
                                continue;
                            }
                            
                            if (!*volume_available && snd_mixer_selem_has_playback_volume(elem)) {
                                if (snd_mixer_selem_has_playback_channel(elem, SND_MIXER_SCHN_FRONT_LEFT) ||
                                    snd_mixer_selem_has_playback_channel(elem, SND_MIXER_SCHN_MONO)) {
                                    *volume_available = 1;
                                }
                            }
                            
                            if (!*mute_available && snd_mixer_selem_has_playback_switch(elem)) {
                                *mute_available = 1;
                            }
                            
                            if (*volume_available && *mute_available) break;
                        }
                    }
                }
            }
        }
        snd_mixer_close(mixer);
    }
}

// Update mixer control cache file
void update_mixer_cache() {
    // Only write cache if we found a valid control
    if (strlen(current_status.mixer_control_name) == 0) {
        printf("No mixer control found, skipping cache update\n");
        return;
    }
    
    FILE *fp = fopen(MIXER_CACHE_FILE, "w");
    if (!fp) {
        printf("WARNING: Cannot open %s for writing: %s\n", MIXER_CACHE_FILE, strerror(errno));
        return;
    }
    
    // Write in format: 'ControlName',index
    fprintf(fp, "'%s',%d\n", current_status.mixer_control_name, current_status.mixer_control_index);
    
    fclose(fp);
    printf("Mixer cache updated: '%s',%d\n", 
           current_status.mixer_control_name, 
           current_status.mixer_control_index);
}

// Update JSON file
void update_status_file() {
    FILE *fp = fopen(STATUS_FILE, "w");
    if (!fp) {
        printf("ERROR: Cannot open %s for writing: %s\n", STATUS_FILE, strerror(errno));
        return;
    }
    
    snprintf(status_json, sizeof(status_json),
             "{\"active_service\":\"%s\",\"alsa_state\":\"%s\","
             "\"usb_dac\":%s,\"volume\":\"%s\",\"muted\":%s,"
             "\"volume_control_available\":%s,\"mute_control_available\":%s,"
             "\"timestamp\":%ld,\"boot_id\":\"%s\",\"source\":\"dbus_monitor\"}\n",
             current_status.active_service, current_status.alsa_state,
             current_status.usb_dac ? "true" : "false", current_status.volume,
             current_status.muted ? "true" : "false",
             current_status.volume_control_available ? "true" : "false",
             current_status.mute_control_available ? "true" : "false",
             current_status.last_update, boot_id);
    fputs(status_json, fp);
    
    fclose(fp);
    
    // Also update mixer cache
    update_mixer_cache();
    publish_status();
}

// Full status update
void refresh_all_status() {
    char old_alsa_state[16];
    int old_usb_dac;
    
    // Save old state to detect DAC changes
    strcpy(old_alsa_state, current_status.alsa_state);
    old_usb_dac = current_status.usb_dac;
    
    get_active_service(current_status.active_service, &active_service_pid);
    get_alsa_state(current_status.alsa_state);
    current_status.usb_dac = check_usb_dac();
    
    // Detect DAC change (output mode or USB DAC presence changed)
    bool dac_changed = (strcmp(old_alsa_state, current_status.alsa_state) != 0) || 
                       (old_usb_dac != current_status.usb_dac);
    
    if (dac_changed) {
        printf("DAC changed: %s->%s, USB DAC: %d->%d - rescanning controls\n",
               old_alsa_state, current_status.alsa_state, old_usb_dac, current_status.usb_dac);
        
        // Invalidate cached control and force rescan
        current_status.mixer_control_valid = false;
        find_mixer_control();
        reset_volume_event_mixer();
    }
    
    get_volume_status_alsa(current_status.volume, &current_status.muted);
    
    // Update control availability based on current state
    if (strcmp(current_status.alsa_state, "usb") == 0 && !current_status.usb_dac) {
        current_status.volume_control_available = 0;
        current_status.mute_control_available = 0;
    } else if (strcmp(current_status.alsa_state, "usb") == 0 && current_status.usb_dac) {
        check_usb_controls(&current_status.volume_control_available, &current_status.mute_control_available);
    } else {
        current_status.volume_control_available = 1;
        current_status.mute_control_available = 1;
    }
    
    current_status.last_update = time(NULL);
    
    update_status_file();
    printf("Status updated: service=%s, alsa=%s, volume=%s\n", 
           current_status.active_service, current_status.alsa_state, current_status.volume);
}

// D-Bus signal handler
DBusHandlerResult handle_dbus_message(DBusConnection *connection, DBusMessage *message, void *user_data) {
    const char *interface = dbus_message_get_interface(message);
    const char *member = dbus_message_get_member(message);
    const char *path = dbus_message_get_path(message);
    
    printf("D-Bus signal: %s.%s on %s\n", interface ? interface : "null", 
           member ? member : "null", path ? path : "null");
    
    if (interface && strcmp(interface, DBUS_INTERFACE_NAME) == 0) {
        if (member && strcmp(member, "ServiceChanged") == 0) {
            printf("Service change detected via D-Bus\n");
            char old_alsa_state[16];
            int old_usb_dac;
            
            strcpy(old_alsa_state, current_status.alsa_state);
            old_usb_dac = current_status.usb_dac;
            
            get_active_service(current_status.active_service, &active_service_pid);
            get_alsa_state(current_status.alsa_state);
            current_status.usb_dac = check_usb_dac();
            
            // Check if DAC changed
            bool dac_changed = (strcmp(old_alsa_state, current_status.alsa_state) != 0) || 
                               (old_usb_dac != current_status.usb_dac);
            
            if (dac_changed) {
                printf("DAC changed from %s (USB:%d) to %s (USB:%d) - rescanning controls\n", 
                       old_alsa_state, old_usb_dac, current_status.alsa_state, current_status.usb_dac);
                
                // Invalidate cache and rescan
                current_status.mixer_control_valid = false;
                find_mixer_control();
                reset_volume_event_mixer();
                
                // Recalculate control availability
                if (strcmp(current_status.alsa_state, "usb") == 0 && !current_status.usb_dac) {
                    current_status.volume_control_available = 0;
                    current_status.mute_control_available = 0;
                } else if (strcmp(current_status.alsa_state, "usb") == 0 && current_status.usb_dac) {
                    check_usb_controls(&current_status.volume_control_available, 
                                     &current_status.mute_control_available);
                } else {
                    current_status.volume_control_available = 1;
                    current_status.mute_control_available = 1;
                }
            }
            
            current_status.last_update = time(NULL);
            update_status_file();
        } else if (member && strcmp(member, "VolumeChanged") == 0) {
            char actual_alsa_state[16];
            int volume;

            printf("Volume change detected via D-Bus\n");
            /*
             * The encoder can be the first producer of a status event after
             * the output is switched. Do not publish its volume update with
             * a stale I2S/USB state, or the web UI can flip the output toggle
             * back to the previous mode.
             */
            get_alsa_state(actual_alsa_state);
            if (strcmp(actual_alsa_state, current_status.alsa_state) != 0) {
                refresh_all_status();
                return DBUS_HANDLER_RESULT_HANDLED;
            }
            if (get_dbus_volume(message, &volume)) {
                snprintf(current_status.volume, sizeof(current_status.volume),
                         "%d%%", volume);
                schedule_volume_persist(current_status.volume);
            } else {
                get_volume_status_alsa(current_status.volume, &current_status.muted);
            }
            current_status.last_update = time(NULL);
            update_status_file();
        }
    }
    
    if (interface && strstr(interface, "systemd")) {
        printf("SystemD signal detected, refreshing services\n");
        get_active_service(current_status.active_service, &active_service_pid);
        get_alsa_state(current_status.alsa_state);
        current_status.last_update = time(NULL);
        update_status_file();
    }
    
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
}

// D-Bus initialization
int init_dbus() {
    DBusError error;
    dbus_error_init(&error);
    
    dbus_conn = dbus_bus_get(DBUS_BUS_SYSTEM, &error);
    if (dbus_error_is_set(&error)) {
        printf("D-Bus connection error: %s\n", error.message);
        dbus_error_free(&error);
        return -1;
    }
    
    dbus_bus_request_name(dbus_conn, DBUS_SERVICE_NAME, 
                         DBUS_NAME_FLAG_DO_NOT_QUEUE, &error);
    if (dbus_error_is_set(&error)) {
        printf("D-Bus name request error: %s\n", error.message);
        dbus_error_free(&error);
        return -1;
    }
    
    char match_rule[512];
    snprintf(match_rule, sizeof(match_rule), 
             "type='signal',interface='%s'", DBUS_INTERFACE_NAME);
    dbus_bus_add_match(dbus_conn, match_rule, &error);
    
    dbus_bus_add_match(dbus_conn, 
                      "type='signal',interface='org.freedesktop.systemd1.Manager'", 
                      &error);
    
    dbus_connection_add_filter(dbus_conn, handle_dbus_message, NULL, NULL);
    
    printf("D-Bus initialized successfully\n");
    return 0;
}

int main() {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    read_boot_id();
    
    FILE *fp = fopen(LOCK_FILE, "w");
    if (fp) {
        fprintf(fp, "%d\n", getpid());
        fclose(fp);
    }
    
    printf("D-Bus Status Monitor started (PID: %d)\n", getpid());
    if (init_event_server() < 0)
        printf("WARNING: Status event socket is unavailable: %s\n", strerror(errno));
    
    if (init_dbus() < 0) {
        static time_t last_full_refresh = 0;
        static long long last_volume_poll = 0;

        printf("Failed to initialize D-Bus, using ALSA event fallback\n");
        refresh_all_status();
        while (running) {
            service_event_clients();
            if (wait_for_volume_event(200))
                refresh_volume_status_if_changed(time(NULL));
            if (monotonic_ms() - last_volume_poll >=
                (have_event_clients() ? 250 : 1000)) {
                refresh_volume_status_if_changed(time(NULL));
                last_volume_poll = monotonic_ms();
            }
            refresh_active_service_state();
            persist_pending_volume();
            if (time(NULL) - last_full_refresh > 30) {
                refresh_all_status();
                last_full_refresh = time(NULL);
            }
        }
    } else {
        refresh_all_status();
        
        printf("Entering D-Bus event loop\n");
        while (running) {
            static time_t last_full_refresh = 0;
            static long long last_volume_poll = 0;
            time_t now = time(NULL);

            /* Process messages already queued before blocking in poll(). */
            dbus_connection_read_write_dispatch(dbus_conn, 0);
            if (poll_status_events(status_poll_timeout(last_volume_poll)))
                refresh_volume_status_if_changed(now);

            refresh_active_service_state();

            if (monotonic_ms() - last_volume_poll >=
                (have_event_clients() ? 250 : 1000)) {
                refresh_volume_status_if_changed(now);
                last_volume_poll = monotonic_ms();
            }
            persist_pending_volume();
            
            if (now - last_full_refresh > 30) {
                refresh_all_status();
                last_full_refresh = now;
            }
        }
        
        if (dbus_conn) {
            dbus_connection_close(dbus_conn);
        }
    }
    
    unlink(LOCK_FILE);
    for (int i = 0; i < EVENT_CLIENTS_MAX; i++) {
        if (event_clients[i] >= 0)
            close_event_client(i);
    }
    if (event_server >= 0)
        close(event_server);
    if (pending_volume_persist >= 0)
        volume_persist_at = 0;
    persist_pending_volume();
    reset_volume_event_mixer();
    unlink(EVENT_SOCKET);
    printf("D-Bus Status Monitor stopped\n");
    
    return 0;
}
