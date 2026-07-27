# PureFox

**Network audio endpoint on Luckfox Pico Max / Ultra with external clock support**


## About

PureFox is a firmware for **Luckfox Pico Max** and **Ultra** boards based on Rockchip RV1106, turning them into a high-quality network audio transport with support for:

#### Network Player Mode

- **I2S** output (external clocking EXT / internal PLL synthesizer)
- **USB** output (UAC2)

#### USB Transport Mode

- USB (UAC2) to I2S

#### Supported Audio Standards

- PCM 2ch up to 768 kHz or PCM 8ch up to 192 kHz
- Native DSD (64–512)

## Specifications

| Parameter          | Value                     |
| ------------------ | ------------------------- |
| Processor          | Rockchip RV1106           |
| Linux Kernel       | 6.1                       |
| Power Consumption  | 80–120 mA                |
| Storage            | SPI NOR Flash or eMMC     |
| Power Supply       | 5V via USB Type-C         |
| Outputs            | I2S (EXT/PLL), USB (UAC2) |

## Firmware

### Download

The latest firmware is available at:

- [MEGA](https://mega.nz/folder/jhJzXZKJ#Y6YbHsS9xCfJL4TKOVeQ4Q) — official release
- [Yandex.Disk](https://disk.yandex.ru/d/g8tOCR7uFATj5Q) — mirror

### Installation (via USB)

1. Install drivers from [Luckfox Wiki](https://wiki.luckfox.com/Luckfox-Pico-RV1106/Downloads)
2. Run [RV1106_Toolkit.exe](https://mega.nz/file/ndFiCATS#CG5lF0Nz7JWhmoyrECxeIQDIw3iS5Lv3PZq-MIzJa9c) as Administrator, select **rv1106**
3. Hold the **BOOT** button on the board and connect USB
4. Wait for **Maskrom** to appear in the program
5. Select Download → USB → Search Path → firmware folder
6. Check all files and click **Download**
7. After **Download done**, wait 1 minute, then disconnect the board

### Web Interface

Once booted, the device is available at `http://purefox/` or by IP. If the home DNS does not resolve short names, use the mDNS address `http://purefox.local/`.
The web interface supports automatic language switching (English, Russian, Chinese, German, French).  
Unused player buttons can be hidden by swiping left.  
The version button at the bottom is for online firmware updates.

SSH access is enabled: login `root`, password: `purefox`.

## Operating Modes

### I2S

- **EXT** — external master clock
- **PLL** — RV1106 frequency synthesizer. The quality of the internal PLL is surprisingly high. According to numerous subjective tests by audio experts, the internal PLL sound quality rivals that of expensive external clock generators.

<img title="" src="images/2026-05-24-10-02-10-image.png" alt="" width="389">

The I2S menu settings are configured in the web interface (the "I2S Settings" page) and let you adapt the I2S output to your DAC:

- **Mode** — `PLL` / `EXT`:
  - `PLL` — clocked by the internal RV1106 synthesizer (MCLK acts as **OUTPUT**).
  - `EXT` — external master clock (MCLK acts as **INPUT**).
- **Output Mode** — `STD` / `8CH` / `L/R` / `±L/±R`:
  - `STD` — standard 2-channel output.
  - `8CH` — 8-channel mode (PCM up to 192 kHz).
  - `L/R` — dual-mono mode.
  - `±L/±R` — dual-mono with balanced output.
- **MCLK** — `512` / `1024` (master clock multiplication factor).
- **PCM Swap** — `OFF` / `ON` — invert channel order for PCM.
- **DSD Swap** — `OFF` / `ON` — invert physical channels for DSD.
- **44/48 Swap** — `OFF` / `ON` — reverse frequency domain order (44.1 / 48 kHz).

> **Warning:** the MCLK output has different settings in PLL and EXT modes (OUTPUT/INPUT), and any change to the I2S settings takes effect only after a **device reboot**.


### USB (UAC2 Gadget)

- PureCore UAC2 — USB Audio Class 2 emulation
- PCM 2ch up to 768 kHz
- DSD support (DoP and Native via Alt-Setting 2)
- **USB to I2S** mode — USB input → I2S output
- Proprietary drivers required for Native DSD and ASIO. Available for testing upon request. Custom ASIO drivers are in development.

### Output Switching

Via web interface: **I2S ↔ USB** toggle

### Volume Encoder

An optional mechanical rotary encoder with a push button controls the master volume: each detent changes it by 1%, and a press toggles mute. The volume position is immediately reflected in the web interface.

| Encoder pin      | Luckfox Pico |
| ---------------- | ----------- |
| A / CLK          | GPIO1_C6    |
| B / DT           | GPIO1_C7    |
| C / COM          | GND         |
| SW               | GPIO1_C5    |
| Other SW pin     | GND         |

The inputs use internal pull-up resistors. Do not connect power to the encoder contacts or apply 5 V to them. If rotation direction is reversed, swap A/CLK and B/DT.

## Supported Players

- NAA (HQPlayer)
- Roon Ready (RAAT)
- Squeezelite (LMS)
- shairport-sync (AirPlay)
- MPD (UPnP)
- APlayer (web radio only)
- APrender (UPnP)
- APScream (Diretta alternative)
- Spotify Connect (librespot)
- Qobuz Connect
- Tidal Connect (test version only!)

## Repository Branches

| Branch       | Platform                  |
| ------------ | ------------------------- |
| `MAX_6.X`    | Luckfox Pico Max          |
| `ULTRA_6.X`  | Luckfox Pico Ultra (eMMC) |

## Pinout (LuckFox Pico MAX example)

![image](https://forum.puredsd.ru/uploads/default/optimized/2X/c/c4b521acfee5bceaba972793da2c3ec7d33bbdbd_2_533x500.jpeg)

BBB — corresponds to BeagleBone Black pins from the related project [Pure_v2](https://github.com/ppy2/Pure_v2)

## Contacts

- Forum: [PureDSD](https://forum.puredsd.ru/t/luckfox-pico-max-ultra-endpoint-s-vneshnimi-klokami-na-rockchip-rv1106/1172)
