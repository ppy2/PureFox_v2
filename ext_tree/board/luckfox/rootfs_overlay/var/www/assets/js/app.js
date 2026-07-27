$(document).ready(function () {
    // Global variables
    let lastKnownStatus = null;
    let isServiceSwitching = false; // Flag to block updates during switching
    let serviceSwitchWatchdog = null;
    let serviceStatusProbeTimer = null;
    let pendingService = null;
    let isVolumeChanging = false; // Flag to block volume updates during user changes
    let isAlsaSwitching = false; // Flag to block ALSA updates during switching
    let statusInterval = null;
    let statusEvents = null;
    let statusEventsConnected = false;
    let statusRecoveryTimer = null;
    let currentBootId = null;
    let rebootRecoveryActive = false;
    let statusRequestSequence = 0;
    let isDlnaBridgeActive = false; // true when DLNA bridge is enabled
    const DEBUG_UI = new URLSearchParams(window.location.search).get('debug') === '1';
    const debugLog = (...args) => { if (DEBUG_UI) console.log(...args); };
    const debugWarn = (...args) => { if (DEBUG_UI) console.warn(...args); };

    function resetServiceSwitchFlag() {
        isServiceSwitching = false;
        pendingService = null;
        if (serviceSwitchWatchdog) {
            clearTimeout(serviceSwitchWatchdog);
            serviceSwitchWatchdog = null;
        }
        if (serviceStatusProbeTimer) {
            clearTimeout(serviceStatusProbeTimer);
            serviceStatusProbeTimer = null;
        }
        hideSpinner();
    }
    
    // Universal interface update function
    function updateInterfaceFromStatus(data) {
        // Update active service ONLY if switching is not in progress AND not in USB-to-I2S
        if (data.active_service !== undefined && !$('#usbto-i2s-btn').hasClass('active')) {
            // During a switch, ignore the stopped player's final status but
            // accept the requested player as soon as status_monitor reports it.
            if (isServiceSwitching && data.active_service === pendingService) {
                resetServiceSwitchFlag();
            }
            if (!isServiceSwitching) {
                $('button[data-service]').removeClass('active');
                if (data.active_service) {
                    $(`button[data-service="${data.active_service}"]`).addClass('active');
                }
            }
        }

        // Update ALSA state ONLY if not switching AND USBtoI2S mode is not enabled
        const usbToI2sEnabled = $('#usbto-i2s-btn').hasClass('active');
        if (data.alsa_state !== undefined && !isAlsaSwitching && !usbToI2sEnabled) {
            updateAlsaUI(data.alsa_state);
        }

        // Update volume only if user is not changing it at the moment
        if (!isVolumeChanging) {
            updateVolumeFromStatus(data);
        }
    }
    let previousActiveService = null;


    // Dynamic URL setup based on current host (PRESERVED!)
    var currentHost = window.location.hostname;
    $('button[data-service="aprenderer"] .settings-link').attr('href', 'http://' + currentHost + ':7779');
    $('button[data-service="aplayer"] .settings-link').attr('href', 'http://' + currentHost + ':7778');

    // Language dictionaries (FULLY PRESERVED!)
    window.translations = {
        'ru': {
            'Output': 'Выход:',
            'i2s_settings': 'Настройки I2S',
            'update_firmware': 'Обновить прошивку',
            'update_firmware_short': 'Обновить',
            'firmware_update': 'Обновление прошивки',
            'close': 'Закрыть',
            'update_start': 'Запуск обновления...',
            'update_finish': 'Обновление завершено. Перезагрузите LuckFox',
            'update_error': 'Ошибка при обновлении.',
            'confirm_update': 'Вы уверены, что хотите обновить прошивку?',
            'alsa_error': 'Ошибка при переключении ALSA',
            'service_error': 'Ошибка при переключении сервиса',
            'service_switch_in_progress': 'Переключение плеера ещё не завершено. Подождите.',
            'settings': '',
            'switching_player': 'Переключение плеера...',
            'switching_output': 'Переключение выхода...',
            'switching_input': 'Переключение входа...',
            'usb_dac_missing': 'USB ЦАП не обнаружен.<br>Пожалуйста, подключите USB ЦАП',
            'confirm_reboot': 'Вы уверены, что хотите перезагрузить систему?',
            'confirm_shutdown': 'Вы уверены, что хотите выключить систему?',
            'shutdown_complete': 'Система выключена. Можете отключить питание.',
            'i2s_title': 'I2S Настройки',
            'back_button': '← Назад',
            'mode_title': 'Режим',
            'pll_mode': 'PLL',
            'ext_mode': 'EXT',
            'submode_title': 'Вариант выхода',
            'lr_mode': 'L/R',
            'plr_mode': '±L/±R',
            'std_mode': 'STD',
            'l_mode': 'L',
            'r_mode': 'R',
            'plusl_mode': '±L',
            'plusr_mode': '±R',
            '8ch_mode': '8CH',
            'mclk_title': 'MCLK',
            'warning_attention': 'Внимание!',
            'warning_text1': 'Выход MCLK в режимах PLL и EXT имеет разные настройки (OUTPUT/INPUT).',
            'warning_text2': 'После изменения настроек I2S необходима перезагрузка системы для вступления в силу.',
            'yes_btn': 'Да',
            'cancel_btn': 'Отмена',
            'apply_reboot': 'Применить и перезагрузить',
            'pcm_swap_title': 'PCM Swap',
            'dsd_swap_title': 'DSD Swap',
            'freq_swap_title': '44/48 Swap',
            'leftjust_title': 'LeftJust'
        },
        'en': {
            'alsa_output': 'ALSA Output:',
            'i2s_settings': 'I2S Settings',
            'update_firmware': 'Update Firmware',
            'update_firmware_short': 'Update',
            'firmware_update': 'Firmware Update',
            'close': 'Close',
            'update_start': 'Starting update...',
            'update_finish': 'Update completed. Please reboot LuckFox',
            'update_error': 'Update error.',
            'confirm_update': 'Are you sure you want to update the firmware?',
            'alsa_error': 'Error switching ALSA',
            'service_error': 'Error switching service',
            'service_switch_in_progress': 'Player switching is still in progress. Please wait.',
            'settings': '',
            'switching_player': 'Switching player...',
            'switching_output': 'Switching output...',
            'switching_input': 'Switching input...',
            'usb_dac_missing': 'USB DAC not detected.<br>Please connect USB DAC',
            'confirm_reboot': 'Are you sure you want to reboot the system?',
            'confirm_shutdown': 'Are you sure you want to shutdown the system?',
            'shutdown_complete': 'System has been shut down. You can disconnect power.',
            'i2s_title': 'I2S Settings',
            'back_button': '← Back',
            'mode_title': 'Mode',
            'pll_mode': 'PLL',
            'ext_mode': 'EXT',
            'submode_title': 'Output Mode',
            'lr_mode': 'L/R',
            'plr_mode': '±L/±R',
            'std_mode': 'STD',
            'l_mode': 'L',
            'r_mode': 'R',
            'plusl_mode': '±L',
            'plusr_mode': '±R',
            '8ch_mode': '8CH',
            'mclk_title': 'MCLK',
            'warning_attention': 'Warning!',
            'warning_text1': 'MCLK output has different settings in PLL and EXT modes (OUTPUT/INPUT).',
            'warning_text2': 'System reboot is required after changing I2S settings to apply them.',
            'yes_btn': 'Yes',
            'cancel_btn': 'Cancel',
            'apply_reboot': 'Apply & Reboot',
            'pcm_swap_title': 'PCM Swap',
            'dsd_swap_title': 'DSD Swap',
            'freq_swap_title': '44/48 Swap',
            'leftjust_title': 'LeftJust'
        },
        'de': {
            'alsa_output': 'ALSA Ausgang:',
            'i2s_settings': 'I2S Einstellungen',
            'update_firmware': 'Firmware aktualisieren',
            'update_firmware_short': 'Update',
            'firmware_update': 'Firmware-Update',
            'close': 'Schließen',
            'update_start': 'Update wird gestartet...',
            'update_finish': 'Update abgeschlossen. Bitte LuckFox neu starten',
            'update_error': 'Update-Fehler.',
            'confirm_update': 'Sind Sie sicher, dass Sie die Firmware aktualisieren möchten?',
            'alsa_error': 'Fehler beim Umschalten von ALSA',
            'service_error': 'Fehler beim Umschalten des Dienstes',
            'service_switch_in_progress': 'Der Playerwechsel wird noch ausgeführt. Bitte warten.',
            'settings': '',
            'switching_player': 'Player wird gewechselt...',
            'switching_output': 'Ausgang wird gewechselt...',
            'switching_input': 'Eingang wird gewechselt...',
            'usb_dac_missing': 'USB-DAC nicht erkannt.<br>Bitte USB-DAC anschließen',
            'confirm_reboot': 'Sind Sie sicher, dass Sie das System neu starten möchten?',
            'confirm_shutdown': 'Sind Sie sicher, dass Sie das System herunterfahren möchten?',
            'shutdown_complete': 'System wurde heruntergefahren. Sie können die Stromversorgung trennen.',
            'i2s_title': 'I2S Einstellungen',
            'back_button': '← Zurück',
            'mode_title': 'Modus',
            'pll_mode': 'PLL',
            'ext_mode': 'EXT',
            'submode_title': 'Ausgangsmodus',
            'lr_mode': 'L/R',
            'plr_mode': '±L/±R',
            'std_mode': 'STD',
            'l_mode': 'L',
            'r_mode': 'R',
            'plusl_mode': '±L',
            'plusr_mode': '±R',
            '8ch_mode': '8CH',
            'mclk_title': 'MCLK',
            'warning_attention': 'Achtung!',
            'warning_text1': 'MCLK-Ausgang hat unterschiedliche Einstellungen in PLL- und EXT-Modi (OUTPUT/INPUT).',
            'warning_text2': 'Systemneustart ist erforderlich, nachdem I2S-Einstellungen geändert wurden.',
            'yes_btn': 'Ja',
            'cancel_btn': 'Abbrechen',
            'apply_reboot': 'Anwenden & Neustart',
            'pcm_swap_title': 'PCM Swap',
            'dsd_swap_title': 'DSD Swap',
            'freq_swap_title': '44/48 Swap',
            'leftjust_title': 'LeftJust'
        },
        'fr': {
            'alsa_output': 'Sortie ALSA:',
            'i2s_settings': 'Paramètres I2S',
            'update_firmware': 'Mettre à jour le firmware',
            'update_firmware_short': 'Mettre à jour',
            'firmware_update': 'Mise à jour du firmware',
            'close': 'Fermer',
            'update_start': 'Démarrage de la mise à jour...',
            'update_finish': 'Mise à jour terminée. Veuillez redémarrer LuckFox',
            'update_error': 'Erreur de mise à jour.',
            'confirm_update': 'Êtes-vous sûr de vouloir mettre à jour le firmware?',
            'alsa_error': 'Erreur lors du changement ALSA',
            'service_error': 'Erreur lors du changement de service',
            'service_switch_in_progress': 'Le changement de lecteur est toujours en cours. Veuillez patienter.',
            'settings': '',
            'switching_player': 'Changement de lecteur...',
            'switching_output': 'Changement de sortie...',
            'switching_input': 'Changement d\'entrée...',
            'usb_dac_missing': 'DAC USB non détecté.<br>Veuillez connecter un DAC USB',
            'confirm_reboot': 'Êtes-vous sûr de vouloir redémarrer le système?',
            'confirm_shutdown': 'Êtes-vous sûr de vouloir arrêter le système?',
            'shutdown_complete': 'Système arrêté. Vous pouvez débrancher l\'alimentation.',
            'i2s_title': 'Paramètres I2S',
            'back_button': '← Retour',
            'mode_title': 'Mode',
            'pll_mode': 'PLL',
            'ext_mode': 'EXT',
            'submode_title': 'Mode de sortie',
            'lr_mode': 'L/R',
            'plr_mode': '±L/±R',
            'std_mode': 'STD',
            'l_mode': 'L',
            'r_mode': 'R',
            'plusl_mode': '±L',
            'plusr_mode': '±R',
            '8ch_mode': '8CH',
            'mclk_title': 'MCLK',
            'warning_attention': 'Attention!',
            'warning_text1': 'La sortie MCLK a des paramètres différents en modes PLL et EXT (OUTPUT/INPUT).',
            'warning_text2': 'Un redémarrage du système est nécessaire après modification des paramètres I2S.',
            'yes_btn': 'Oui',
            'cancel_btn': 'Annuler',
            'apply_reboot': 'Appliquer et redémarrer',
            'pcm_swap_title': 'PCM Swap',
            'dsd_swap_title': 'DSD Swap',
            'freq_swap_title': '44/48 Swap',
            'leftjust_title': 'LeftJust'
        },
        'zh': {
            'alsa_output': 'ALSA 输出:',
            'i2s_settings': 'I2S 设置',
            'update_firmware': '更新固件',
            'update_firmware_short': '更新',
            'firmware_update': '固件更新',
            'close': '关闭',
            'update_start': '开始更新...',
            'update_finish': '更新完成。请重启 LuckFox',
            'update_error': '更新错误。',
            'confirm_update': '您确定要更新固件吗？',
            'alsa_error': 'ALSA 切换错误',
            'service_error': '服务切换错误',
            'service_switch_in_progress': '播放器仍在切换中，请稍候。',
            'settings': '',
            'switching_player': '正在切换播放器...',
            'switching_output': '正在切换输出...',
            'switching_input': '正在切换输入...',
            'usb_dac_missing': '未检测到 USB DAC。<br>请连接 USB DAC',
            'confirm_reboot': '您确定要重启系统吗？',
            'confirm_shutdown': '您确定要关闭系统吗？',
            'shutdown_complete': '系统已关闭。您可以断开电源。',
            'i2s_title': 'I2S 设置',
            'back_button': '← 返回',
            'mode_title': '主模式',
            'pll_mode': 'PLL',
            'ext_mode': 'EXT',
            'submode_title': '输出模式',
            'lr_mode': 'L/R',
            'plr_mode': '±L/±R',
            'std_mode': 'STD',
            'l_mode': 'L',
            'r_mode': 'R',
            'plusl_mode': '±L',
            'plusr_mode': '±R',
            '8ch_mode': '8CH',
            'mclk_title': 'MCLK',
            'warning_attention': '注意！',
            'warning_text1': 'MCLK输出在PLL和EXT模式下具有不同的设置（OUTPUT/INPUT）。',
            'warning_text2': '更改I2S设置后需要重启系统才能生效。',
            'yes_btn': '是',
            'cancel_btn': '取消',
            'apply_reboot': '应用并重启',
            'pcm_swap_title': 'PCM Swap',
            'dsd_swap_title': 'DSD Swap',
            'freq_swap_title': '44/48 Swap',
            'leftjust_title': 'LeftJust'
        }
    };

    // Browser language detection (PRESERVED!)
    window.detectLanguage = function() {
        const lang = navigator.language || navigator.userLanguage;
        if (lang.startsWith('ru')) return 'ru';
        if (lang.startsWith('de')) return 'de';
        if (lang.startsWith('fr')) return 'fr';
        if (lang.startsWith('zh')) return 'zh';
        return 'en';
    }

    // Language application (PRESERVED!)
    window.currentLang = window.detectLanguage();

    window.applyTranslations = function() {
        $('[data-lang]').each(function() {
            const key = $(this).data('lang');
            if (window.translations[window.currentLang][key] !== undefined) {
                if (key !== 'settings' || !$(this).find('img').length) {
                    $(this).text(window.translations[window.currentLang][key]);
                }
            }
        });
    }

    window.applyTranslations();

    // Adaptive styles (FULLY PRESERVED!)
    function setResponsiveStyles() {
        if (window.innerWidth < 500) {
            $('.player-buttons, .ap-buttons, .streaming-buttons').css({
                'display': 'block',
                'gap': '0'
            });
            $('.player-buttons .btn-custom, .ap-buttons .btn-custom, .streaming-buttons .btn-custom').css({
                'width': '100%',
                'margin-top': '10px',
                'margin-bottom': '0'
            });
            $('.alsa-button').css('padding', '10px');
        } else {
            $('.player-buttons, .ap-buttons, .streaming-buttons').css({
                'display': 'flex',
                'gap': '10px'
            });
            $('.player-buttons .btn-custom, .ap-buttons .btn-custom, .streaming-buttons .btn-custom').css({
                'width': 'calc(50% - 5px)',
                'margin-top': '0',
                'margin-bottom': '0'
            });
            $('.alsa-button').css('padding', '10px 20px');
        }
    }

    setResponsiveStyles();
    $(window).resize(function() {
        setResponsiveStyles();
    });
    
    // Check CSS gap support
    function checkGapSupport() {
        const testElement = document.createElement('div');
        testElement.style.display = 'flex';
        testElement.style.gap = '10px';
        if (testElement.style.gap === '10px') {
            document.documentElement.classList.add('supports-gap');
        }
    }
    checkGapSupport();

    // Force status check on user actions
    function forceStatusCheck() {
        const requestSequence = ++statusRequestSequence;

        debugLog('Принудительная проверка состояния...');
        $.ajax({
            url: 'status_fast.php?_=' + Date.now(),
            method: 'GET',
            timeout: 3000,
            dataType: 'json',
            cache: false,
            success: function(response) {
                if (requestSequence !== statusRequestSequence) {
                    return;
                }
                debugLog('Принудительная проверка:', response);
                handleBootIdentity(response);
                updateInterfaceFromStatus(response);
                lastKnownStatus = response;
            },
            error: function() {
                debugWarn('Ошибка принудительной проверки');
            }
        });
    }

    // Refresh status from backend after delayed service transitions.
    function updateStatusFromServer() {
        $.ajax({
            url: 'status_fast.php',
            method: 'GET',
            timeout: 3000,
            dataType: 'json',
            cache: false,
            success: function(response) {
                handleBootIdentity(response);
                lastKnownStatus = response;
                updateInterfaceFromStatus(response);
            },
            error: function(xhr, status, error) {
                console.error('Status refresh failed:', status, error);
            }
        });
    }

    // This is a short-lived fallback for an SSE reconnect during a switch.
    // status_fast.php only reads status_monitor's already prepared JSON.
    function probeServiceStart(service) {
        if (!isServiceSwitching || pendingService !== service) {
            return;
        }

        $.ajax({
            url: 'status_fast.php',
            method: 'GET',
            timeout: 1000,
            dataType: 'json',
            cache: false,
            success: function(response) {
                if (!isServiceSwitching || pendingService !== service) {
                    return;
                }
                lastKnownStatus = response;
                updateInterfaceFromStatus(response);
                if (isServiceSwitching) {
                    serviceStatusProbeTimer = setTimeout(function() {
                        probeServiceStart(service);
                    }, 250);
                }
            },
            error: function() {
                if (isServiceSwitching && pendingService === service) {
                    serviceStatusProbeTimer = setTimeout(function() {
                        probeServiceStart(service);
                    }, 250);
                }
            }
        });
    }

    function startStatusEvents() {
        if (!window.EventSource || statusEvents) {
            return;
        }

        statusEvents = new EventSource('status_events.php');
        statusEvents.onopen = function() {
            statusEventsConnected = true;
            if (statusRecoveryTimer) {
                clearTimeout(statusRecoveryTimer);
                statusRecoveryTimer = null;
            }
        };
        statusEvents.addEventListener('status', function(event) {
            try {
                const response = JSON.parse(event.data);
                statusEventsConnected = true;
                handleBootIdentity(response);
                lastKnownStatus = response;
                updateInterfaceFromStatus(response);
            } catch (error) {
                debugWarn('Invalid status event:', error);
            }
        });
        statusEvents.onerror = function() {
            statusEventsConnected = false;
            scheduleStatusRecovery();
        };
    }

    function handleBootIdentity(data) {
        if (!data || !data.boot_id) {
            return;
        }
        if (currentBootId && currentBootId !== data.boot_id) {
            beginRebootRecovery();
            return;
        }
        currentBootId = data.boot_id;
    }

    function beginRebootRecovery() {
        if (rebootRecoveryActive) {
            return;
        }
        rebootRecoveryActive = true;
        const rebootText = {
            'ru': 'Система перезагружается...',
            'de': 'System wird neu gestartet...',
            'fr': 'Le systeme redemarre...',
            'zh': '系统正在重启...',
            'en': 'System is rebooting...'
        };
        const language = detectLanguage();
        showSpinner(rebootText[language] || rebootText.en);
        setTimeout(function() {
            window.location.reload();
        }, 300);
    }

    function scheduleStatusRecovery() {
        if (statusRecoveryTimer || rebootRecoveryActive) {
            return;
        }
        statusRecoveryTimer = setTimeout(function() {
            statusRecoveryTimer = null;
            $.ajax({
                url: 'status_fast.php?_=' + Date.now(),
                method: 'GET',
                timeout: 1000,
                dataType: 'json',
                cache: false,
                success: function(response) {
                    handleBootIdentity(response);
                    lastKnownStatus = response;
                    updateInterfaceFromStatus(response);
                    restartStatusEvents();
                },
                error: scheduleStatusRecovery
            });
        }, 2000);
    }

    function restartStatusEvents() {
        if (statusEvents) {
            statusEvents.close();
            statusEvents = null;
        }
        statusEventsConnected = false;
        startStatusEvents();
    }

    // Track page visibility
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            restartStatusEvents();
            forceStatusCheck();
        }
    });

    window.addEventListener('pageshow', function() {
        restartStatusEvents();
        forceStatusCheck();
    });

    // Spinner control (PRESERVED!)
    function showSpinner(text = null) {
        if (text) {
            $('.spinner-text').text(text);
        }
        $('.spinner-overlay').addClass('show');
    }

    function hideSpinner() {
        $('.spinner-overlay').removeClass('show');
    }

    // Check USB DAC via forced status check
    function checkUsbDac(successCallback, errorCallback) {
        // Always do fresh check for USB DAC - it can be connected/disconnected
        $.ajax({
            url: 'status_fast.php',
            method: 'GET',
            timeout: 3000,
            dataType: 'json',
            cache: false, // Принудительно отключаем кеширование
            success: function(response) {
                lastKnownStatus = response;
                updateInterfaceFromStatus(response);
                
                if (response.usb_dac) {
                    if (successCallback) successCallback();
                } else {
                    customAlert(translations[currentLang]['usb_dac_missing']);
                    if (errorCallback) errorCallback();
                }
            },
            error: function(xhr, status, error) {
                console.error('AJAX error in checkUsbDac:', status, error, 'Response:', xhr.responseText);
                customAlert(translations[currentLang]['service_error'] + ': ' + status);
                if (errorCallback) errorCallback();
            }
        });
    }

    // Принудительная проверка состояния сервисов (только по требованию)
    function checkActiveService(callback) {
        debugLog('Проверка активного сервиса...');
        $.ajax({
            url: 'status_fast.php',
            method: 'GET',
            timeout: 3000,
            dataType: 'json',
            success: function(response) {
                const activeService = response.active_service || '';
                
                lastKnownStatus = response;
                
                // Обновляем UI
                if (!isServiceSwitching && activeService !== previousActiveService) {
                    if (previousActiveService !== null && previousActiveService !== activeService) {
                        hideSpinner();
                    }
                    previousActiveService = activeService;
                    $('button[data-service]').removeClass('active');
                    if (activeService) {
                        $(`button[data-service="${activeService}"]`).addClass('active');
                    }
                }
                
                if (!$('#usbto-i2s-btn').hasClass('active')) {
                    updateAlsaUI(response.alsa_state);
                }
                if (!isVolumeChanging) {
                    updateVolumeFromStatus(response);
                }
                
                if (callback) callback(activeService);
            },
            error: function() {
                debugWarn('Ошибка проверки состояния');
            }
        });
    }

    // Output selector UI update (usb / i2s / bridge)
    function updateAlsaUI(alsaState) {
        debugLog("updateAlsaUI called, state:", alsaState);
        const toggleInput = $('#alsa-toggle');
        const i2sSettingsLink = $('#i2s-settings-link');

        $('.alsa-toggle').removeClass('active-i2s');

        switch (alsaState) {
            case 'usb':
                toggleInput.prop('checked', false);
                i2sSettingsLink.addClass('no-transition').css({
                    'opacity': '0.3',
                    'pointer-events': 'none',
                    'cursor': 'not-allowed'
                });
                setTimeout(() => i2sSettingsLink.removeClass('no-transition'), 10);
                break;
            case 'i2s':
            case 'bridge':
                toggleInput.prop('checked', true);
                $('.alsa-toggle').addClass('active-i2s');
                i2sSettingsLink.addClass('no-transition').css({
                    'opacity': '1',
                    'pointer-events': 'auto',
                    'cursor': 'pointer'
                });
                setTimeout(() => i2sSettingsLink.removeClass('no-transition'), 10);
                break;
            case 'error':
                console.error('Ошибка при чтении конфигурации ALSA');
                break;
        }
    }

    // Проверка состояния ALSA через принудительную проверку
    function checkAlsaState() {
        // Используем последнее известное состояние
        if (lastKnownStatus && lastKnownStatus.alsa_state) {
            updateAlsaUI(lastKnownStatus.alsa_state);
            return;
        }
        
        // Иначе принудительно проверяем
        checkActiveService();
    }

    // ALSA toggle: USB ↔ I2S
    $('#alsa-toggle').change(function(e) {
        e.preventDefault();
        const checkbox = $(this);
        const isChecked = checkbox.is(':checked');
        const cardType = isChecked ? 'i2s' : 'usb';

        updateAlsaUI(cardType);
        isAlsaSwitching = true;
        forceStatusCheck();

        if (cardType === 'usb') {
            const doSwitch = function() {
                if (isDlnaBridgeActive) {
                    $.ajax({ url: 'handle_dlna.php', method: 'POST', data: { action: 'disable' },
                        success: function() { isDlnaBridgeActive = false; localStorage.removeItem('dlna_bridge_active'); $('#dlna-bridge-btn').removeClass('active'); switchAlsa('usb'); },
                        error: function() { isAlsaSwitching = false; forceStatusCheck(); }
                    });
                } else {
                    switchAlsa(cardType);
                }
            };
            checkUsbDac(doSwitch, function() {
                checkbox.prop('checked', !isChecked);
                updateAlsaUI(!isChecked ? 'i2s' : 'usb');
                isAlsaSwitching = false;
            });
        } else {
            switchAlsa(cardType);
        }
    });

    // DLNA Bridge button — toggle on/off
    $('#dlna-bridge-btn').click(function() {
        if (isDlnaBridgeActive) {
            isDlnaBridgeActive = false;
            localStorage.removeItem('dlna_bridge_active');
            $(this).removeClass('active');
            $.ajax({
                url: 'handle_dlna.php', method: 'POST', data: { action: 'disable' },
                success: function() { forceStatusCheck(); },
                error: function() {
                    isDlnaBridgeActive = true;
                    localStorage.setItem('dlna_bridge_active', 'true');
                    $('#dlna-bridge-btn').addClass('active');
                }
            });
        } else {
            isDlnaBridgeActive = true;
            localStorage.setItem('dlna_bridge_active', 'true');
            $(this).addClass('active');
            $.ajax({
                url: 'handle_dlna.php', method: 'POST', data: { action: 'enable' },
                timeout: 15000,
                success: function() { forceStatusCheck(); },
                error: function() {
                    isDlnaBridgeActive = false;
                    localStorage.removeItem('dlna_bridge_active');
                    $('#dlna-bridge-btn').removeClass('active');
                    customAlert('DLNA bridge enable failed');
                }
            });
        }
    });

    // Упрощенная функция переключения ALSA
    function switchAlsa(cardType) {
        // UI уже обновлен пользователем (toggle switch), просто отправляем команду
        $.ajax({
            url: 'handle_alsa.php',
            method: 'POST',
            data: { card: cardType },
            timeout: 10000,
            success: function() {
                // UI уже обновлен при клике, просто разблокируем обновления
                setTimeout(() => {
                    isAlsaSwitching = false;
                }, 2000);
            },
            error: function() {
                // При ошибке возвращаем toggle в исходное состояние
                const oppositeState = (cardType === 'usb') ? 'i2s' : 'usb';
                updateAlsaUI(oppositeState);
                isAlsaSwitching = false; // Разблокируем обновления
            }
        });
    }

    // Обработка кликов по кнопкам сервисов (ПОЛНОСТЬЮ СОХРАНЕНА!)
    $('.btn-custom').click(function(e) {
        if ($(e.target).is('a') || $(e.target).is('img')) return true;
        if (!$(this).data('service')) return;
        
        if (isServiceSwitching || window.purefoxServiceSwitchInProgress) {
            customAlert(translations[currentLang]['service_switch_in_progress']);
            return;
        }

        if ($(this).hasClass('active')) return;

        const service = $(this).data('service');
        
        // Используем последнее известное состояние ALSA
        const alsaState = lastKnownStatus ? lastKnownStatus.alsa_state : null;
        if (alsaState === 'usb') {
            checkUsbDac(function() { switchPlayerService(service); });
        } else {
            switchPlayerService(service);
        }
    });

    // Функция переключения сервиса с мгновенной активацией кнопки
    function switchPlayerService(service) {
        // Блокируем обновления кнопок во время переключения
        isServiceSwitching = true;
        window.purefoxServiceSwitchInProgress = true;
        pendingService = service;
        if (serviceSwitchWatchdog) clearTimeout(serviceSwitchWatchdog);
        serviceSwitchWatchdog = setTimeout(function() {
            resetServiceSwitchFlag();
        }, 45000);

        // Unlock ALSA toggle and deactivate USBtoI2S button when switching to any player
        unlockAlsaToggle();
        $('#usbto-i2s-btn').removeClass('active');

        // СРАЗУ делаем кнопку активной для отзывчивости UI
        $('button[data-service]').removeClass('active');
        $(`button[data-service="${service}"]`).addClass('active');
        debugLog('Кнопка', service, 'активирована мгновенно, ожидаем запуск сервиса...');
        probeServiceStart(service);

        // Переключение сервиса
        
        // Увеличенный таймаут для сервисов с двухэтапным запуском
        const timeoutDuration = (service === 'qobuz') ? 15000 : (service === 'tidalconnect') ? 12000 : 8000;
        

        $.ajax({
            url: 'handle_service.php',
            method: 'POST',
            data: { service: service },
            timeout: 15000,
            dataType: 'json',
            success: function(result) {
                if (!result || result.status !== 'success') {
                    console.error('Service switch rejected:', result);
                    resetServiceSwitchFlag();
                    $('.btn-custom').removeClass('active');
                    customAlert((result && result.message) || translations[currentLang]['service_error']);
                    return;
                }
                if (!isServiceSwitching || pendingService !== service) {
                    return;
                }
                debugLog('Команда переключения на', service, 'отправлена, начинаем проверку...');
                
                // Сразу начинаем проверку без задержки
                const checkInterval = 500; // 500ms между проверками
                let checkCount = 0;
                const maxChecks = 60; // 20 секунд максимум

                function checkServiceStatusChange() {
                        $.ajax({
                            url: 'status_fast.php', // Используем оптимизированный запрос
                            method: 'GET',
                            timeout: 3000,
                            dataType: 'json',
                            success: function(response) {
                                const activeService = response.active_service || '';
                                checkCount++;
                                
                                debugLog('Проверка', checkCount, ': активный сервис =', activeService, ', ожидаемый =', service);
                                
                                if (!activeService) {
                                    debugWarn('Нет активных сервисов, продолжаем проверку... (попытка', checkCount, 'из', maxChecks, ')');
                                    if (checkCount >= maxChecks) {
                                        console.error('Сервис', service, 'не поднялся после максимального числа попыток');
                                        resetServiceSwitchFlag();
                                        $('.btn-custom').removeClass('active');
                                        customAlert(translations[currentLang]['service_error']);
                                        return;
                                    }
                                    // Продолжаем проверку, кнопка остается активной
                                    setTimeout(checkServiceStatusChange, checkInterval);
                                    return;
                                }
                                
                                if (activeService === service) {
                                    debugLog('Успешно переключен на', service);
                                    resetServiceSwitchFlag();
                                    lastKnownStatus = response;
                                    updateInterfaceFromStatus(response);
                                    debugLog('Сервис переключен успешно');

                                    // Принудительно обновляем данные из system_status.json через 2.5s
                                    // (учитываем задержку обновления status_monitor ~2s)
                                    setTimeout(() => {
                                        debugLog('Обновление данных после переключения источника...');
                                        updateStatusFromServer();
                                    }, 2500);
                                } else if (checkCount >= maxChecks) {
                                    console.error("Тайм-аут при переключении на сервис " + service);
                                    resetServiceSwitchFlag();
                                    $('.btn-custom').removeClass('active');
                                    customAlert(translations[currentLang]['service_error']);
                                } else {
                                    // The old player can remain in status_monitor briefly
                                    // after its process has been stopped. Keep waiting for
                                    // the requested service instead of reverting the UI.
                                    debugLog("Ожидаем " + service + ", пока активен " + activeService);
                                    setTimeout(checkServiceStatusChange, checkInterval);
                                }
                            },
                            error: function(xhr, status, error) {
                                checkCount++;
                                debugWarn('Ошибка проверки состояния:', status, error);
                                if (checkCount >= maxChecks) {
                                    console.error('Тайм-аут проверки состояния:', status, error);
                                    resetServiceSwitchFlag();
                                    $('.btn-custom').removeClass('active');
                                    customAlert(translations[currentLang]['service_error']);
                                    return;
                                }
                                setTimeout(checkServiceStatusChange, checkInterval);
                            }
                        });
                    }

                // Запускаем проверку сразу
                checkServiceStatusChange();
            },
            error: function(xhr, status, error) {
                console.error('AJAX error switching to', service, ':', status, error, 'Response:', xhr.responseText);
                resetServiceSwitchFlag();
                $('.btn-custom').removeClass('active');
                customAlert(translations[currentLang]['service_error'] + ': ' + status);
            },
            complete: function() {
                window.purefoxServiceSwitchInProgress = false;
            }
        });
    }

    // Инициализация
    checkActiveService(function(activeService) {
        previousActiveService = activeService;
    });
    checkAlsaState();

    // Кастомный confirm диалог
    function customConfirm(message, callback) {
        $('#confirm-message').html(message);
        $('#custom-confirm').addClass('show');
        
        // Обновляем текст кнопок на основе языка
        const yesText = {
            'ru': 'Да',
            'de': 'Ja',
            'fr': 'Oui',
            'zh': '是',
            'en': 'Yes'
        };
        const cancelText = {
            'ru': 'Отмена',
            'de': 'Abbrechen',
            'fr': 'Annuler',
            'zh': '取消',
            'en': 'Cancel'
        };
        $('#confirm-yes').text(yesText[currentLang] || yesText['en']);
        $('#confirm-no').text(cancelText[currentLang] || cancelText['en']);
        
        // Обработчики кнопок
        $('#confirm-yes').off('click').on('click', function() {
            $('#custom-confirm').removeClass('show');
            callback(true);
        });
        
        $('#confirm-no').off('click').on('click', function() {
            $('#custom-confirm').removeClass('show');
            callback(false);
        });
    }
    
    function customAlert(message) {
        $('#alert-message').html(message);
        $('#custom-alert').addClass('show');
        
        // Обновляем текст кнопки на основе языка
        $('#alert-ok').text('OK');
        
        // Обработчик кнопки
        $('#alert-ok').off('click').on('click', function() {
            $('#custom-alert').removeClass('show');
        });
        
        // Закрытие по клику на фон
        $('#custom-alert').off('click').on('click', function(e) {
            if (e.target === this) {
                $('#custom-alert').removeClass('show');
            }
        });
    }

    // ПОЛНОСТЬЮ СОХРАНЕНА функция обновления прошивки!
    $('#update-firmware').click(function(e) {
        
        customConfirm(translations[currentLang]['confirm_update'], function(confirmed) {
            if (!confirmed) return;

        $('#update-log-modal').addClass('show');
        $('#update-log-content').text(translations[currentLang]['update_start'] + "\n");
        let logContent = $('#update-log-content');

        $.ajax({
            url: 'run_update.php',
            method: 'GET',
            xhrFields: {
                onprogress: function(e) {
                    let newText = e.currentTarget.responseText;
                    logContent.append(newText);
                    setTimeout(() => { logContent.scrollTop(logContent.prop("scrollHeight")); }, 100);
                }
            },
            success: function() {
                logContent.html(logContent.html());
                logContent.append('\n<span class="update-finish">' + translations[currentLang]['update_finish'] + '</span>');
            },
            error: function() {
                logContent.append('\n<span class="update-error">' + translations[currentLang]['update_error'] + '</span>');
                logContent.html(logContent.html());
            }
        });
        });
    });

    // СОХРАНЕНА функция закрытия модального окна
    $('.close-modal').click(function() {
        $('#update-log-modal').removeClass('show');
    });

    // Обработчики для reboot и shutdown
    $('#reboot-link').click(function(e) {
        e.preventDefault();
        customConfirm(translations[currentLang]['confirm_reboot'], function(confirmed) {
            if (confirmed) {
            $('.spinner-overlay').addClass('show');
            const rebootText = {
                'ru': 'Перезагрузка...',
                'de': 'Neustart...',
                'fr': 'Redémarrage...',
                'zh': '重启中...',
                'en': 'Rebooting...'
            };
            $('.spinner-text').text(rebootText[currentLang] || rebootText['en']);
            
            $.ajax({
                url: 'reboot.php',
                method: 'POST',
                success: function() {
                    // Ждем восстановления соединения после перезагрузки
                    setTimeout(checkConnectionAfterReboot, 3000);
                },
                error: function() {
                    // Если запрос не прошел, все равно ждем восстановления
                    setTimeout(checkConnectionAfterReboot, 3000);
                }
            });
            }
        });
    });

    $('#shutdown-link').click(function(e) {
        e.preventDefault();
        customConfirm(translations[currentLang]['confirm_shutdown'], function(confirmed) {
            if (confirmed) {
            $('.spinner-overlay').addClass('show');
            const shutdownText = {
                'ru': 'Выключение...',
                'de': 'Herunterfahren...',
                'fr': 'Arrêt en cours...',
                'zh': '关机中...',
                'en': 'Shutting down...'
            };
            $('.spinner-text').text(shutdownText[currentLang] || shutdownText['en']);
            
            $.ajax({
                url: 'shutdown.php',
                method: 'POST',
                success: function() {
                    // Показываем сообщение о завершении через 3 секунды
                    setTimeout(function() {
                        $('.spinner').hide();
                        $('.spinner-text').text(translations[currentLang]['shutdown_complete']);
                    }, 3000);
                },
                error: function() {
                    const errorText = {
                        'ru': 'Ошибка при выключении',
                        'de': 'Fehler beim Herunterfahren',
                        'fr': 'Erreur d\'arrêt',
                        'zh': '关机错误',
                        'en': 'Shutdown error'
                    };
                    customAlert(errorText[currentLang] || errorText['en']);
                    $('.spinner-overlay').removeClass('show');
                }
            });
            }
        });
    });

    // Функция проверки соединения после перезагрузки
    function checkConnectionAfterReboot() {
        $.ajax({
            url: 'status_fast.php',
            method: 'GET',
            timeout: 2000,
            success: function() {
                // Соединение восстановлено, перезагружаем страницу
                location.reload();
            },
            error: function() {
                // Соединение еще не восстановлено, ждем еще
                setTimeout(checkConnectionAfterReboot, 2000);
            }
        });
    }

    // Volume Control
    let volumeSlider = document.getElementById('volume-slider');
    let volumeDisplay = document.getElementById('volume-display');
    let volumeIcon = document.getElementById('volume-icon');
    let isMuted = false;
    let volumeCommitTimer = null;
    let volumeReleaseTimer = null;
    let pendingVolume = null;
    let volumeRequestInFlight = false;
    let lastSentVolume = null;
    let lastVolumeRequestAt = 0;
    let volumeKeyboardAdjusting = false;
    const VOLUME_REQUEST_INTERVAL_MS = 100;

    // Обновляем громкость из уже полученных данных status_fast.php (НЕ отдельный запрос!)
    function updateVolumeFromStatus(data) {
        // Handle volume and mute control availability separately
        let volumeControlsAvailable = true;
        let muteControlsAvailable = true;
        
        debugLog('Volume update:', data.volume, 'available:', data.volume_control_available, 'changing:', isVolumeChanging);
        
        if (data.volume_control_available !== undefined) {
            volumeControlsAvailable = data.volume_control_available;
            if (volumeSlider) {
                volumeSlider.disabled = !volumeControlsAvailable;
                volumeSlider.style.opacity = volumeControlsAvailable ? '1' : '0.4';
                volumeSlider.style.cursor = volumeControlsAvailable ? 'pointer' : 'not-allowed';
                volumeSlider.style.pointerEvents = volumeControlsAvailable ? 'auto' : 'none';
            }
        }
        
        if (data.mute_control_available !== undefined) {
            muteControlsAvailable = data.mute_control_available;
            if (volumeIcon) {
                volumeIcon.style.opacity = muteControlsAvailable ? '1' : '0.4';
                volumeIcon.style.cursor = muteControlsAvailable ? 'pointer' : 'not-allowed';
                volumeIcon.style.pointerEvents = muteControlsAvailable ? 'auto' : 'none';
            }
        }
        
        // Always update volume display if volume data is available
        if (data.volume) {
            if (volumeControlsAvailable) {
                let volume = parseInt(data.volume.replace('%', ''));
                if (volumeSlider && volumeSlider.value != volume) {
                    volumeSlider.value = volume;
                }
                if (volumeDisplay) {
                    volumeDisplay.textContent = volume.toString();
                }
            } else {
                // For non-controllable DACs, show 100 in both display and slider
                if (volumeDisplay) {
                    volumeDisplay.textContent = '100';
                }
                if (volumeSlider && volumeSlider.value != 100) {
                    volumeSlider.value = 100;
                }
            }
        } else {
            // If no volume data available, show 100 (for DACs without volume controls)
            if (volumeDisplay && volumeDisplay.textContent === '--') {
                volumeDisplay.textContent = '100';
            }
            if (volumeSlider && volumeSlider.value != 100) {
                volumeSlider.value = 100;
            }
        }
        
        // Устанавливаем правильную иконку в зависимости от состояния mute
        if (volumeIcon) {
            const newMuted = data.muted || false;
            if (isMuted !== newMuted) {
                isMuted = newMuted;
                if (isMuted) {
                    volumeIcon.src = 'assets/img/mute.svg';
                    const unmuteText = {
                        'ru': 'Включить звук',
                        'de': 'Ton einschalten',
                        'fr': 'Activer le son',
                        'zh': '开启声音',
                        'en': 'Unmute'
                    };
                    volumeIcon.title = unmuteText[currentLang] || unmuteText['en'];
                } else {
                    volumeIcon.src = 'assets/img/volume.svg';
                    const volumeText = {
                        'ru': 'Громкость',
                        'de': 'Lautstärke',
                        'fr': 'Volume',
                        'zh': '音量',
                        'en': 'Volume'
                    };
                    volumeIcon.title = volumeText[currentLang] || volumeText['en'];
                }
            }
        }
    }

    function releaseVolumeUpdateLock() {
        if (volumeReleaseTimer) {
            clearTimeout(volumeReleaseTimer);
        }
        volumeReleaseTimer = setTimeout(() => {
            if (!volumeRequestInFlight && pendingVolume === null) {
                isVolumeChanging = false;
            }
        }, 250);
    }

    // Send only one volume request at a time. While it is in flight, retain
    // just the latest slider value instead of queueing every keyboard repeat.
    function setVolume() {
        if (volumeRequestInFlight || pendingVolume === null) {
            return;
        }

        const volume = pendingVolume;
        pendingVolume = null;
        lastSentVolume = volume;
        lastVolumeRequestAt = Date.now();
        volumeRequestInFlight = true;

        fetch('volume.php', {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: 'action=set_volume&volume=' + volume
        })
        .then(response => response.json())
        .then(data => {
            if (data.disabled) {
                debugLog('Volume control disabled:', data.reason);
                return;
            }
            if (data.success) {
                volumeDisplay.textContent = volume;
            }
        })
        .catch(error => {
            console.error('Error setting volume:', error);
        })
        .finally(() => {
            volumeRequestInFlight = false;
            if (pendingVolume !== null && pendingVolume !== lastSentVolume) {
                scheduleVolumeUpdate(pendingVolume, false);
            } else {
                pendingVolume = null;
                releaseVolumeUpdateLock();
            }
        });
    }

    function scheduleVolumeUpdate(volume, immediately) {
        isVolumeChanging = true;

        if (volumeReleaseTimer) {
            clearTimeout(volumeReleaseTimer);
            volumeReleaseTimer = null;
        }

        if (!volumeRequestInFlight && pendingVolume === null && volume === lastSentVolume) {
            releaseVolumeUpdateLock();
            return;
        }

        pendingVolume = volume;
        if (immediately) {
            if (volumeCommitTimer) {
                clearTimeout(volumeCommitTimer);
                volumeCommitTimer = null;
            }
            setVolume();
        } else if (!volumeCommitTimer) {
            const elapsed = Date.now() - lastVolumeRequestAt;
            const delay = Math.max(0, VOLUME_REQUEST_INTERVAL_MS - elapsed);
            volumeCommitTimer = setTimeout(() => {
                volumeCommitTimer = null;
                setVolume();
            }, delay);
        }
    }

    // Toggle mute
    function toggleMute() {
        isVolumeChanging = true; // Блокируем обновления громкости
        
        fetch('volume.php', {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: 'action=toggle_mute'
        })
        .then(response => response.json())
        .then(data => {
            if (data.disabled) {
                debugLog('Mute control disabled:', data.reason);
                isVolumeChanging = false;
                return;
            }
            if (data.success) {
                isMuted = data.muted;
                if (isMuted) {
                    volumeIcon.src = 'assets/img/mute.svg';
                    const unmuteText = {
                        'ru': 'Включить звук',
                        'de': 'Ton einschalten',
                        'fr': 'Activer le son',
                        'zh': '开启声音',
                        'en': 'Unmute'
                    };
                    volumeIcon.title = unmuteText[currentLang] || unmuteText['en'];
                } else {
                    volumeIcon.src = 'assets/img/volume.svg';
                    const volumeText = {
                        'ru': 'Громкость',
                        'de': 'Lautstärke',
                        'fr': 'Volume',
                        'zh': '音量',
                        'en': 'Volume'
                    };
                    volumeIcon.title = volumeText[currentLang] || volumeText['en'];
                }
            }
            // Разблокируем через 1 секунду
            setTimeout(() => {
                isVolumeChanging = false;
            }, 1000);
        })
        .catch(error => {
            console.error('Error toggling mute:', error);
            // Разблокируем даже при ошибке
            setTimeout(() => {
                isVolumeChanging = false;
            }, 1000);
        });
    }

    // Volume slider event listener
    if (volumeSlider) {
        volumeSlider.addEventListener('keydown', function(event) {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
                event.key === 'Home' || event.key === 'End' ||
                event.key === 'PageUp' || event.key === 'PageDown') {
                volumeKeyboardAdjusting = true;
            }
        });

        volumeSlider.addEventListener('input', function() {
            let volume = this.value;
            volumeDisplay.textContent = volume;
            scheduleVolumeUpdate(volume, false);
        });

        volumeSlider.addEventListener('change', function() {
            scheduleVolumeUpdate(this.value, !volumeKeyboardAdjusting);
        });

        volumeSlider.addEventListener('keyup', function(event) {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
                event.key === 'Home' || event.key === 'End' ||
                event.key === 'PageUp' || event.key === 'PageDown') {
                volumeKeyboardAdjusting = false;
                scheduleVolumeUpdate(this.value, true);
            }
        });

        volumeSlider.addEventListener('pointerup', function() {
            scheduleVolumeUpdate(this.value, true);
        });

        // Wheel is active only over the volume slider.  Use the same request
        // coalescing path as drag/keyboard control, so fast scrolling does
        // not create a burst of ALSA updates on the single-core SBC.
        volumeSlider.addEventListener('wheel', function(event) {
            if (this.disabled || event.deltaY === 0) {
                return;
            }

            event.preventDefault();
            const step = Number(this.step) || 1;
            const direction = event.deltaY < 0 ? 1 : -1;
            const nextVolume = Math.max(Number(this.min) || 0,
                Math.min(Number(this.max) || 100,
                    Number(this.value) + direction * step));

            if (nextVolume === Number(this.value)) {
                return;
            }

            this.value = nextVolume;
            volumeDisplay.textContent = String(nextVolume);
            scheduleVolumeUpdate(String(nextVolume), false);
        }, {passive: false});

        // Начальное состояние загрузится через polling
    }

    // Volume icon click listener
    if (volumeIcon) {
        volumeIcon.addEventListener('click', function(e) {
            e.preventDefault();
            toggleMute();
        });
    }
    
    // Очистка интервалов при выходе со страницы
    window.addEventListener('beforeunload', function() {
        if (statusInterval) {
            clearInterval(statusInterval);
        }
        if (statusEvents) {
            statusEvents.close();
        }
    });
    
    // Инициализация polling системы
    function startPolling() {
        forceStatusCheck();
        startStatusEvents();

        // SSE delivers state changes immediately. This is only a recovery path
        // when the event connection is temporarily unavailable.
        statusInterval = setInterval(function() {
            if (!statusEventsConnected) {
                forceStatusCheck();
            }
        }, 30000);
    }
    
    startPolling();

    // ===== USBtoI2S BUTTON FUNCTIONALITY =====
    const USBTOI2S_LOCK_KEY = 'usbToI2sLocked';

    // Function to lock ALSA toggle (USB to I2S mode)
    function lockAlsaToggle() {
        localStorage.setItem(USBTOI2S_LOCK_KEY, 'true');
        const toggleInput = $('#alsa-toggle');
        const toggleLabel = $('#alsa-toggle').next('.toggle-label');
        toggleInput.prop('disabled', true);
        toggleLabel.addClass('disabled');
        toggleLabel.css({
            'opacity': '0.4',
            'pointer-events': 'none',
            'cursor': 'not-allowed'
        });
    }

    // Function to unlock ALSA toggle
    function unlockAlsaToggle() {
        localStorage.removeItem(USBTOI2S_LOCK_KEY);
        const toggleInput = $('#alsa-toggle');
        const toggleLabel = $('#alsa-toggle').next('.toggle-label');
        toggleInput.prop('disabled', false);
        toggleLabel.removeClass('disabled');
        toggleLabel.css({
            'opacity': '',
            'pointer-events': '',
            'cursor': ''
        });
    }

    // Check USBtoI2S status and lock toggle if enabled
    function checkUsbToI2sStatus() {
        debugLog("checkUsbToI2sStatus called");
        $.ajax({
            url: 'usb_to_i2s.php',
            method: 'POST',
            data: { action: 'status' },
            dataType: 'json',
            timeout: 3000,
            success: function(response) {
                debugLog("checkUsbToI2sStatus response:", response);
                if (response.enabled) {
                    debugLog("ADDING active class to button");
                    $('button[data-service]').removeClass('active');
                    $('#usbto-i2s-btn').addClass('active');
                    lockAlsaToggle();
                    updateAlsaUI('i2s');
                    debugLog("After addClass:", $('#usbto-i2s-btn').attr('class'));
                } else {
                    $('#usbto-i2s-btn').removeClass('active');
                }
            }
        });
    }

    // Check status on page load
    window.checkUsbToI2sStatus = checkUsbToI2sStatus;
    checkUsbToI2sStatus();

    // USBtoI2S button click handler - toggle mode
    $('#usbto-i2s-btn').click(function() {
        const isEnabled = $(this).hasClass('active');

        if (isEnabled) {
            // Disable mode
            const confirmDisable = {
                'ru': 'Отключить режим USBtoI2S?',
                'en': 'Disable USBtoI2S mode?',
                'de': 'USBtoI2S-Modus deaktivieren?',
                'fr': 'Désactiver le mode USBtoI2S?',
                'zh': '禁用USBtoI2S模式？'
            };

            customConfirm(confirmDisable[currentLang] || confirmDisable['en'], function(confirmed) {
                if (confirmed) {
                    isAlsaSwitching = true;
                    showSpinner(translations[currentLang]['switching_input']);

                    // Мгновенная деактивация кнопки
                    $('#usbto-i2s-btn').removeClass('active');

                    $.ajax({
                        url: 'usb_to_i2s.php',
                        method: 'POST',
                        data: { action: 'disable' },
                        timeout: 15000,
                        success: function() {
                            unlockAlsaToggle();
                            isAlsaSwitching = false;
                            hideSpinner();
                            forceStatusCheck();
                        },
                        error: function(xhr, status, error) {
                            isAlsaSwitching = false;
                            hideSpinner();
                            $('#usbto-i2s-btn').addClass('active');
                            console.error('USBtoI2S disable error:', status, error, 'Response:', xhr.responseText);
                            customAlert(translations[currentLang]['alsa_error']);
                        }
                    });
                }
            });
        } else {
            // Enable mode
            isAlsaSwitching = true;
            showSpinner(translations[currentLang]['switching_input']);

            // Мгновенная активация кнопки
            $('button[data-service]').removeClass('active');
            $('#usbto-i2s-btn').addClass('active');

            $.ajax({
                        url: 'usb_to_i2s.php',
                        method: 'POST',
                        data: { action: 'enable' },
                        timeout: 15000,
                        success: function() {
                            lockAlsaToggle();
                            isAlsaSwitching = false;
                            hideSpinner();
                            checkUsbToI2sStatus();
                        },
                        error: function(xhr, status, error) {
                            isAlsaSwitching = false;
                            hideSpinner();
                            $('#usbto-i2s-btn').removeClass('active');
                            console.error('USBtoI2S enable error:', status, error, 'Response:', xhr.responseText);
                            customAlert(translations[currentLang]['alsa_error']);
                        }
                    });
                }
    });

    // I2S Modal functions
    window.openI2SModal = function() {
        // Load current I2S settings
        $.ajax({
            url: 'handle_i2s.php?action=getStatus',
            method: 'GET',
            dataType: 'json',
            success: function(data) {
                // Set mode toggle
                if (data.mode === 'pll') {
                    $('#modal-mode-pll').prop('checked', true);
                } else {
                    $('#modal-mode-ext').prop('checked', true);
                }
                
                // Set MCLK toggle
                if (data.mclk === '512') {
                    $('#modal-mclk-512').prop('checked', true);
                } else {
                    $('#modal-mclk-1024').prop('checked', true);
                }
                
                // Set PCM swap toggle
                if (data.pcm_swap === '1') {
                    $('#modal-pcm-swap').prop('checked', true);
                } else {
                    $('#modal-pcm-normal').prop('checked', true);
                }
                
                // Set DSD swap toggle
                if (data.dsd_swap === '1') {
                    $('#modal-dsd-swap').prop('checked', true);
                } else {
                    $('#modal-dsd-normal').prop('checked', true);
                }
                
                // Set freq swap toggle
                if (data.freq_swap === '1') {
                    $('#modal-freq-swap').prop('checked', true);
                } else {
                    $('#modal-freq-normal').prop('checked', true);
                }
                
                // Set leftjust toggle
                if (data.leftjust === '1') {
                    $('#modal-leftjust-on').prop('checked', true);
                } else {
                    $('#modal-leftjust-off').prop('checked', true);
                }
                
                // Set submode buttons active state
                $('.i2s-submode-btn').removeClass('active');
                $(`.i2s-submode-btn[value="${data.submode}"]`).addClass('active');
                
                // Apply translations
                applyTranslationsToModal();
                
                // Show modal
                $('#i2s-modal').addClass('show');
            },
            error: function() {
                console.error('Failed to load I2S settings');
            }
        });
    };

    window.closeI2SModal = function() {
        $('#i2s-modal').removeClass('show');
    };

    window.confirmRebootI2S = function(event) {
        if (event) {
            event.preventDefault();
        }
        const currentLang = detectLanguage();
        const rebootMessages = {
            'ru': 'Применить настройки I2S и перезагрузить устройство?',
            'en': 'Apply I2S settings and reboot the device?',
            'de': 'I2S-Einstellungen anwenden und Gerät neu starten?',
            'fr': 'Appliquer les paramètres I2S et redémarrer l\'appareil?',
            'zh': '应用I2S设置并重启设备？'
        };
        const message = rebootMessages[currentLang] || rebootMessages['en'];
        
        customConfirm(message, function(confirmed) {
            if (confirmed) {
                applyI2SSettings();
            }
        });
        return false;
    };

    function applyI2SSettings() {
        const formData = new FormData();
        
        // Get selected mode
        const mode = $('input[name="mode"]:checked').val();
        if (mode) formData.append('mode', mode);
        
        // Get selected MCLK
        const mclk = $('input[name="mclk"]:checked').val();
        if (mclk) formData.append('mclk', mclk);
        
        // Get selected submode
        const activeSubmodeBtn = $('.i2s-submode-btn.active');
        if (activeSubmodeBtn.length > 0) {
            formData.append('submode', activeSubmodeBtn.attr('value'));
        }
        
        // Show spinner
        $('.spinner-overlay').addClass('show');
        const currentLang = detectLanguage();
        const rebootingTexts = {
            'ru': 'Применение настроек и перезагрузка...',
            'en': 'Applying settings and rebooting...',
            'de': 'Anwenden der Einstellungen und Neustart...',
            'fr': 'Application des paramètres et redémarrage...',
            'zh': '应用设置并重启中...'
        };
        $('.spinner-text').text(rebootingTexts[currentLang] || rebootingTexts['en']);
        
        // Close modal first
        closeI2SModal();
        
        // Apply settings
        fetch('handle_i2s.php', {
            method: 'POST',
            body: formData
        }).then(() => {
            // Reboot after applying settings
            return fetch('reboot.php', { method: 'POST' });
        }).then(() => {
            setTimeout(checkConnectionAfterReboot, 3000);
        }).catch(() => {
            setTimeout(checkConnectionAfterReboot, 3000);
        });
    }

    function applyTranslationsToModal() {
        const currentLang = detectLanguage();
        const translations = window.translations[currentLang] || window.translations['en'];
        
        $('#i2s-modal [data-lang]').each(function() {
            const key = $(this).data('lang');
            if (translations[key]) {
                $(this).text(translations[key]);
            }
        });
    }

    // I2S Modal event handlers - submit submode immediately like in original i2s.php
    $(document).on('click', '.i2s-submode-btn', function() {
        $('.i2s-submode-btn').removeClass('active');
        $(this).addClass('active');
        
        const formData = new FormData();
        formData.append('submode', $(this).attr('value'));
        
        // Apply submode setting immediately
        fetch('handle_i2s.php', {
            method: 'POST',
            body: formData
        }).then(() => {
            debugLog(`Applied submode: ${$(this).attr('value')}`);
        }).catch(error => {
            console.error('Error applying submode:', error);
        });
    });
    
    // Handle toggle switches in modal - submit immediately like in original i2s.php
    $(document).on('change', '#i2s-modal .toggle-input-compact', function() {
        if (this.checked) {
            const formData = new FormData();
            
            if (this.name === 'mode') {
                formData.append('mode', this.value);
            } else if (this.name === 'mclk') {
                formData.append('mclk', this.value);
            } else if (this.name === 'pcm_swap') {
                formData.append('pcm_swap', this.value);
            } else if (this.name === 'dsd_swap') {
                formData.append('dsd_swap', this.value);
            } else if (this.name === 'freq_swap') {
                formData.append('freq_swap', this.value);
            } else if (this.name === 'leftjust') {
                formData.append('leftjust', this.value);
            }
            
            // Apply setting immediately
            fetch('handle_i2s.php', {
                method: 'POST',
                body: formData
            }).then(() => {
                // Settings applied successfully
                debugLog(`Applied ${this.name}: ${this.value}`);
            }).catch(error => {
                console.error('Error applying setting:', error);
            });
        }
    });

    // Prevent modal from closing when clicking inside modal content
    $(document).on('click', '#i2s-modal .modal-content', function(e) {
        e.stopPropagation();
    });
    
    // Close modal when clicking outside
    $(document).on('click', '#i2s-modal', function() {
        closeI2SModal();
    });

    // I2S settings link handler
    $(document).on('click', '#i2s-settings-link', function(e) {
        e.preventDefault();
        openI2SModal();
        return false;
    });

    // ===== SWIPE TO HIDE BUTTONS FUNCTIONALITY =====
    const HIDDEN_BUTTONS_KEY = 'hiddenButtons';
    let startX = 0;
    let endX = 0;
    const SWIPE_THRESHOLD = 100;

    // Load hidden buttons from localStorage on page load
    function loadHiddenButtons() {
        const hidden = localStorage.getItem(HIDDEN_BUTTONS_KEY);
        if (hidden) {
            try {
                const hiddenArray = JSON.parse(hidden);
                hiddenArray.forEach(id => {
                    if (id.startsWith('#')) {
                        $(id).hide();
                    } else {
                        $(`button[data-service="${id}"]`).hide();
                    }
                });
            } catch (e) {
                console.error('Failed to parse hidden buttons:', e);
            }
        }
    }

    // Save hidden buttons to localStorage
    function saveHiddenButtons() {
        const hiddenButtons = [];
        $('button[data-service]').each(function() {
            if ($(this).is(':hidden')) {
                hiddenButtons.push($(this).data('service'));
            }
        });
        ['#usbto-i2s-btn', '#dlna-bridge-btn'].forEach(id => {
            if ($(id).is(':hidden')) hiddenButtons.push(id);
        });
        localStorage.setItem(HIDDEN_BUTTONS_KEY, JSON.stringify(hiddenButtons));
    }

    // Handle swipe gestures on player buttons (touch and mouse)
    $('button[data-service], #usbto-i2s-btn, #dlna-bridge-btn').each(function() {
        const $button = $(this);
        let isDragging = false;
        
        // Touch events
        this.addEventListener('touchstart', function(e) {
            startX = e.changedTouches[0].screenX;
        }, { passive: true });

        this.addEventListener('touchend', function(e) {
            endX = e.changedTouches[0].screenX;
            handleSwipe($button);
        }, { passive: true });

        // Mouse events for desktop
        $button.on('mousedown', function(e) {
            startX = e.screenX;
            isDragging = false;
        });

        $button.on('mousemove', function(e) {
            if (e.buttons === 1) { // Left mouse button is pressed
                isDragging = true;
            }
        });

        $button.on('mouseup', function(e) {
            if (isDragging) {
                endX = e.screenX;
                handleSwipe($button);
                e.preventDefault();
                e.stopPropagation();
            }
            isDragging = false;
        });
    });

    function handleSwipe($button) {
        const swipeDistance = endX - startX;
        
        // Swipe left to hide
        if (swipeDistance < -SWIPE_THRESHOLD) {
            const serviceName = $button.text().trim();
            const currentHost = window.location.hostname;
            const resetUrl = `http://${currentHost}/default.php`;
            
            const hideText = {
                'ru': 'Скрыть кнопку',
                'en': 'Hide button',
                'de': 'Schaltfläche ausblenden',
                'fr': 'Masquer le bouton',
                'zh': '隐藏按钮'
            };
            
            const restoreText = {
                'ru': 'Для восстановления всех кнопок откройте:',
                'en': 'To restore all buttons, visit:',
                'de': 'Um alle Schaltflächen wiederherzustellen, besuchen Sie:',
                'fr': 'Pour restaurer tous les boutons, visitez:',
                'zh': '要恢复所有按钮，请访问：'
            };
            
            const message = `${hideText[currentLang] || hideText['en']} "${serviceName}"?<br><br>${restoreText[currentLang] || restoreText['en']}<br>${resetUrl}`;
            
            customConfirm(message, function(confirmed) {
                if (confirmed) {
                    const buttonHeight = $button.outerHeight(true);
                    
                    // Шаг 1: Фиксируем высоту БЕЗ transition
                    $button.css({
                        'height': buttonHeight + 'px',
                        'overflow': 'hidden'
                    });
                    
                    // Шаг 2: Через 20ms добавляем transition и запускаем обе анимации
                    setTimeout(function() {
                        $button.css({
                            'transition': 'height 1s ease-in-out, margin 1s ease-in-out, opacity 1s ease, transform 1s ease, filter 1s ease'
                        });
                        
                        // Шаг 3: Через 20ms запускаем распыление и схлопывание одновременно
                        setTimeout(function() {
                            $button.addClass('btn-dissolving');
                            $button.css({
                                'height': '0',
                                'margin-top': '0',
                                'margin-bottom': '0'
                            });
                            
                            setTimeout(function() {
                                $button.hide();
                                saveHiddenButtons();
                                checkAndExpandButtons();
                            }, 1000);
                        }, 20);
                    }, 20);
                }
            });
        }
    }

    // Check if button pairs need to expand to full width
    function checkAndExpandButtons() {
        // Only on desktop (width > 500px)
        if (window.innerWidth <= 500) return;
        
        // Check each player-buttons container individually
        $('.player-buttons').each(function() {
            const $visible = $(this).find('button[data-service]:visible');
            if ($visible.length === 1) {
                $visible.css('width', '100%');
            }
        });
        
        // Check each streaming-buttons container individually
        $('.streaming-buttons').each(function() {
            const $visible = $(this).find('button[data-service]:visible');
            if ($visible.length === 1) {
                $visible.css('width', '100%');
            }
        });
    }

    // Load hidden buttons on page load
    loadHiddenButtons();
    checkAndExpandButtons();

    // ===== DLNA BRIDGE FUNCTIONALITY =====

    let dlnaRenderers = [];         // discovered renderer list
    let dlnaSelected  = null;       // currently selected renderer object

    function initDlnaBridge() {
        // Restore button state immediately from localStorage to prevent flash on refresh
        if (localStorage.getItem('dlna_bridge_active') === 'true') {
            isDlnaBridgeActive = true;
            $('#dlna-bridge-btn').addClass('active');
        }
        $.ajax({
            url: 'handle_dlna.php?action=status',
            method: 'GET',
            timeout: 5000,
            dataType: 'json',
            success: function(data) {
                if (data.bridge_state === 'enabled') {
                    isDlnaBridgeActive = true;
                    localStorage.setItem('dlna_bridge_active', 'true');
                    $('#dlna-bridge-btn').addClass('active');
                } else {
                    isDlnaBridgeActive = false;
                    localStorage.removeItem('dlna_bridge_active');
                    $('#dlna-bridge-btn').removeClass('active');
                }
                updateDlnaStreamInfo(data.stream);
                if (data.renderer_ip) {
                    dlnaSelected = {
                        ip:          data.renderer_ip,
                        port:        data.renderer_port,
                        control_url: ''
                    };
                    $('#dlna-manual-ip').val(data.renderer_ip);
                    $('#dlna-manual-port').val(data.renderer_port);
                }
            },
            error: function() {
                debugWarn('DLNA bridge status unavailable');
                // Keep localStorage state — bridge may still be running
            }
        });
    }

    function updateDlnaStreamInfo(stream) {
        if (!stream || !stream.active) {
            $('#dlna-stream-info').text('Stream: inactive');
            return;
        }
        $('#dlna-stream-info').text(
            'Stream: ' + stream.rate + ' Hz / ' + stream.bits + '-bit / ' +
            stream.channels + 'ch  —  clients: ' + stream.clients
        );
    }

    // Settings modal — open (called from inline onclick in HTML)
    window.openDlnaModal = function() {
        $('#dlna-modal').addClass('show');
        $.ajax({
            url: 'handle_dlna.php?action=status',
            method: 'GET',
            timeout: 3000,
            dataType: 'json',
            success: function(data) {
                updateDlnaStreamInfo(data.stream);
                if (data.renderer_ip) {
                    $('#dlna-manual-ip').val(data.renderer_ip);
                    $('#dlna-manual-port').val(data.renderer_port);
                }
            }
        });
    };

    // Close modal
    $('#dlna-modal-close').click(function() {
        $('#dlna-modal').removeClass('show');
    });
    $('#dlna-modal').click(function(e) {
        if (e.target === this) $('#dlna-modal').removeClass('show');
    });
    $('#dlna-modal .modal-content').click(function(e) { e.stopPropagation(); });

    // Discover button
    $('#dlna-discover-btn').click(function() {
        $('#dlna-renderer-list').html('<em>Discovering...</em>');
        $.ajax({
            url: 'handle_dlna.php?action=discover',
            method: 'GET',
            timeout: 8000,
            dataType: 'json',
            success: function(renderers) {
                dlnaRenderers = renderers;
                if (!renderers || renderers.length === 0) {
                    $('#dlna-renderer-list').html('<em>No renderers found</em>');
                    return;
                }
                var html = '<strong>Found renderers:</strong><ul style="list-style:none;padding:0;margin:4px 0">';
                renderers.forEach(function(r, i) {
                    html += '<li style="cursor:pointer;padding:4px 6px;border-radius:4px" ' +
                            'class="dlna-renderer-item" data-idx="' + i + '">' +
                            r.name + ' (' + r.ip + ':' + r.port + ')</li>';
                });
                html += '</ul>';
                $('#dlna-renderer-list').html(html);

                // Click to select
                $('.dlna-renderer-item').click(function() {
                    var idx = parseInt($(this).data('idx'));
                    dlnaSelected = dlnaRenderers[idx];
                    $('#dlna-manual-ip').val(dlnaSelected.ip);
                    $('#dlna-manual-port').val(dlnaSelected.port);
                    $('#dlna-manual-url').val(dlnaSelected.control_url);
                    $('.dlna-renderer-item').css('background', '');
                    $(this).css('background', '#2a4a2a');
                });
            },
            error: function() {
                $('#dlna-renderer-list').html('<em>Discovery failed</em>');
            }
        });
    });

    // Push button
    $('#dlna-push-btn').click(function() {
        var ip   = $('#dlna-manual-ip').val().trim();
        var port = parseInt($('#dlna-manual-port').val().trim()) || 0;
        var url  = $('#dlna-manual-url').val().trim();

        if (!ip || !port) {
            customAlert('Please enter renderer IP and port (or use Discover)');
            return;
        }

        // Save renderer config then push
        $.ajax({
            url: 'handle_dlna.php',
            method: 'POST',
            data: { action: 'setrenderer', renderer_ip: ip, renderer_port: port, control_url: url },
            timeout: 5000,
            dataType: 'json',
            success: function() {
                $.ajax({
                    url: 'handle_dlna.php',
                    method: 'POST',
                    data: { action: 'push' },
                    timeout: 5000,
                    dataType: 'json',
                    success: function(resp) {
                        if (resp.success) {
                            customAlert('Stream pushed to renderer');
                        } else {
                            customAlert('Push failed: ' + (resp.error || 'unknown'));
                        }
                    },
                    error: function() { customAlert('Push request failed'); }
                });
            },
            error: function() { customAlert('Failed to save renderer settings'); }
        });
    });

    // Init on page load
    initDlnaBridge();

});
