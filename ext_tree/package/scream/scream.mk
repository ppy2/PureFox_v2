SCREAM_VERSION = 3.5
SCREAM_SOURCE = $(SCREAM_VERSION).tar.gz
SCREAM_SITE = https://github.com/duncanthrax/scream/archive/refs/tags
SCREAM_SUBDIR = Receivers/unix
SCREAM_DEPENDENCIES = alsa-lib host-pkgconf
SCREAM_CONF_OPTS = -DPULSEAUDIO_ENABLE=OFF -DALSA_ENABLE=ON

$(eval $(cmake-package))
