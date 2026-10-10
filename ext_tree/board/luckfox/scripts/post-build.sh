#!/bin/sh

set -ve

[ "$#" -ge 1 ] || {
    echo "Usage: $0 <target-dir>" >&2
    exit 1
}

TARGET_DIR=$1
: "${BUILD_DIR:?Buildroot must provide BUILD_DIR}"
: "${BINARIES_DIR:?Buildroot must provide BINARIES_DIR}"
: "${HOST_DIR:?Buildroot must provide HOST_DIR}"
LINUX_DIR="$BUILD_DIR/linux-custom"
MKSQUASHFS="$HOST_DIR/bin/mksquashfs"

BOOT_SIZE=4194304
DTB_OFFSET=3932160
ZIMAGE="$LINUX_DIR/arch/arm/boot/zImage"
BOOT_DTB="$LINUX_DIR/arch/arm/boot/dts/rv1106_pll.dtb"
BOOT_IMAGE_TMP="$BINARIES_DIR/.boot.img.$$"

trap 'rm -f "$BOOT_IMAGE_TMP"' EXIT HUP INT TERM

[ -f "$ZIMAGE" ] || {
    echo "Kernel image not found: $ZIMAGE" >&2
    exit 1
}
[ -f "$BOOT_DTB" ] || {
    echo "Boot DTB not found: $BOOT_DTB" >&2
    exit 1
}

zimage_size=$(wc -c < "$ZIMAGE")
dtb_size=$(wc -c < "$BOOT_DTB")
if [ "$zimage_size" -gt "$DTB_OFFSET" ]; then
    echo "zImage overlaps DTB in boot.img" >&2
    exit 1
fi
if [ $((DTB_OFFSET + dtb_size)) -gt "$BOOT_SIZE" ]; then
    echo "DTB exceeds boot.img bounds" >&2
    exit 1
fi

# Copy kernel and DTB to binaries
cp "$ZIMAGE" "$BINARIES_DIR/zImage"
cp "$BOOT_DTB" "$BINARIES_DIR/rv1106_pll.dtb"

# Copy DTBs to target
cp "$LINUX_DIR/arch/arm/boot/dts/rv1106_ext.dtb" "$TARGET_DIR/data/boot/1024_ext.dtb"
cp "$BOOT_DTB" "$TARGET_DIR/data/boot/1024_pll.dtb"
cp "$LINUX_DIR/arch/arm/boot/dts/rv1106_512_ext.dtb" "$TARGET_DIR/data/boot/512_ext.dtb"

# Create boot.img with zImage and DTB, then publish it atomically.
dd if=/dev/zero of="$BOOT_IMAGE_TMP" bs=1 count=0 seek="$BOOT_SIZE"
dd if="$BINARIES_DIR/zImage" of="$BOOT_IMAGE_TMP" conv=notrunc
dd if="$BINARIES_DIR/rv1106_pll.dtb" of="$BOOT_IMAGE_TMP" bs=1 seek="$DTB_OFFSET" conv=notrunc
mv "$BOOT_IMAGE_TMP" "$BINARIES_DIR/boot.img"
rm "$BINARIES_DIR/zImage"

rm -f $TARGET_DIR/etc/init.d/*shairport-sync
rm -f $TARGET_DIR/etc/init.d/*upmpdcli
rm -f $TARGET_DIR/etc/init.d/*urandom
rm -f $TARGET_DIR/etc/init.d/*mpd
rm -f $TARGET_DIR/etc/init.d/S40network
#rm -f $TARGET_DIR/etc/init.d/*mdev
rm -f -r $TARGET_DIR/etc/alsa
#rm -f -r $(TARGET_DIR/var/db
echo "uprclautostart = 1" > $TARGET_DIR/etc/upmpdcli.conf
echo "friendlyname = PureOS" >> $TARGET_DIR/etc/upmpdcli.conf
#sed -i "s/console::respawn/#console::respawn/g" $TARGET_DIR/etc/inittab
sed -i "s/#PermitRootLogin prohibit-password/PermitRootLogin yes/g" $TARGET_DIR/etc/ssh/sshd_config
chown root:root $TARGET_DIR/usr/bin/php-cgi || true
chmod u+s $TARGET_DIR/usr/bin/php-cgi


# Add www-data to audio group for ALSA access without sudo
sed -i 's/^audio:x:29:upmpdcli$/audio:x:29:upmpdcli,www-data/' $TARGET_DIR/etc/group

# Remove GDB Python helper files (they prevent buildroot's strip from working)
find $TARGET_DIR -name "*-gdb.py" -delete

# Strip external toolchain libraries (buildroot's target-finalize runs BEFORE post-build)
# When packages are reinstalled, libraries are copied unstripped, so we strip them here
STRIP_BIN="$HOST_DIR/opt/ext-toolchain/bin/arm-none-linux-gnueabihf-strip"
strip_external_libraries() {
    library="$1"
    directory="$2"

    if [ -f "$library" ] && file "$library" | grep -q "not stripped"; then
        [ -x "$STRIP_BIN" ] || {
            echo "Host strip binary not found: $STRIP_BIN" >&2
            exit 1
        }
        echo "Stripping external toolchain libraries in $directory..."
        find "$directory" -name "*.so*" -type f -exec "$STRIP_BIN" {} \;
    fi
}

strip_external_libraries "$TARGET_DIR/usr/lib/libstdc++.so.6.0.33" "$TARGET_DIR/usr/lib"
strip_external_libraries "$TARGET_DIR/lib/libstdc++.so.6.0.33" "$TARGET_DIR/lib"

# Remove duplicate libraries from /lib (keep only in /usr/lib)
# External toolchain duplicates libraries in /lib and /usr/lib
echo "Removing duplicate libraries from /lib..."
rm -f $TARGET_DIR/lib/libstdc++.so.6*
rm -f $TARGET_DIR/lib/libstdc++.so
rm -f $TARGET_DIR/lib/libgcc_s.so.1
rm -f $TARGET_DIR/lib/libatomic.so.1*
rm -f $TARGET_DIR/lib/libatomic.so
rm -f $TARGET_DIR/lib/libgfortran.so.5*
rm -f $TARGET_DIR/lib/libgfortran.so
rm -f $TARGET_DIR/lib/libgomp.so.1*
rm -f $TARGET_DIR/lib/libgomp.so

# Compress large binaries with UPX (MAX only - save rootfs space)
#if command -v upx >/dev/null 2>&1; then
#    echo "Compressing binaries with UPX..."
#    find $TARGET_DIR/usr/bin -type f -size +500k -executable ! -name "*.so*" -exec upx --best --lzma {} \; 2>/dev/null || true
#    find $TARGET_DIR/usr/sbin -type f -size +500k -executable ! -name "*.so*" -exec upx --best --lzma {} \; 2>/dev/null || true
#    find $TARGET_DIR/usr/ap* -type f -size +500k -executable ! -name "*.so*" -exec upx --best --lzma {} \; 2>/dev/null || true
#fi

# Create SquashFS for Tidal libraries (MAX only - save rootfs space)
if [ -d "$TARGET_DIR/usr/lib/tidal" ] && [ "$(ls -A $TARGET_DIR/usr/lib/tidal/*.so* 2>/dev/null)" ]; then
    echo "Creating SquashFS image for Tidal..."
    [ -x "$MKSQUASHFS" ] || {
        echo "Host mksquashfs not found: $MKSQUASHFS" >&2
        exit 1
    }
    rm -f $TARGET_DIR/usr/lib/tidal.sqfs
    "$MKSQUASHFS" "$TARGET_DIR/usr/lib/tidal" "$TARGET_DIR/usr/lib/tidal.sqfs" -comp xz -b 256K -noappend
    echo "Removing original Tidal directory from rootfs..."
    rm -rf $TARGET_DIR/usr/lib/tidal/*
fi






