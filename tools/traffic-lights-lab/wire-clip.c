// Research-only reproduction of the 25G342 global-clip list message.
// No patching or foreign memory access. Caller must bind an owned disposable child window.
#include <CoreGraphics/CoreGraphics.h>
#include <mach/mach.h>
#include <mach/ndr.h>
#include <mach-o/loader.h>
#include <dlfcn.h>
#include <stddef.h>
#include <string.h>
#include <sys/sysctl.h>

#pragma pack(push, 4)
struct ClipMessage {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_ool_descriptor_t region;
    NDR_record_t ndr;
    uint32_t region_length;
    uint32_t window_count;
    uint32_t window;
};
#pragma pack(pop)
_Static_assert(offsetof(struct ClipMessage, region) == 28, "OOL offset");
_Static_assert(offsetof(struct ClipMessage, window) == 60, "window offset");
_Static_assert(sizeof(struct ClipMessage) == 64, "message size");

int margin_wire_clip(uint32_t connection, uint32_t window, void *region) {
#if !defined(__arm64__)
    return -1;
#else
    char build[32] = {0}; size_t length = sizeof(build);
    if (sysctlbyname("kern.osversion", build, &length, NULL, 0) || strcmp(build, "25G342")) return -2;
    void *sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW);
    void *cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW);
    Dl_info info = {0};
    if (!sky || !cg || !dladdr(dlsym(sky, "SLSMainConnectionID"), &info)) return -3;
    const struct mach_header_64 *image = info.dli_fbase;
    if (image->magic != MH_MAGIC_64) return -4;
    const unsigned char expected_uuid[16] = {0xd4,0x22,0xf0,0xa4,0x1c,0x28,0x35,0xb7,0xa6,0xf5,0x9e,0xb7,0xbb,0xe0,0x80,0x1e};
    const struct load_command *command = (const void *)(image + 1);
    int matched = 0;
    for (uint32_t i = 0; i < image->ncmds; ++i) {
        if (command->cmd == LC_UUID && command->cmdsize == sizeof(struct uuid_command)) {
            matched = !memcmp(((const struct uuid_command *)command)->uuid, expected_uuid, 16);
        }
        command = (const void *)((const char *)command + command->cmdsize);
    }
    if (!matched) return -5;
    // Local cache-aware disassembly: _CGSGetConnectionPortById at image + 0x5b04.
    mach_port_t (*connection_port)(uint32_t) = (void *)((const char *)image + 0x5b04);
    int (*get_data)(void *, const void **, uint32_t *) = dlsym(cg, "CGSGetRegionData");
    const void *bytes = NULL; uint32_t count = 0;
    if (!get_data || get_data(region, &bytes, &count) || !bytes || count == 0 || count > 65536) return -6;
    struct ClipMessage message = {0};
    message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
    message.header.msgh_remote_port = connection_port(connection);
    message.header.msgh_id = 0x7614;
    message.header.msgh_size = sizeof(message);
    if (!MACH_PORT_VALID(message.header.msgh_remote_port)) return -7;
    message.body.msgh_descriptor_count = 1;
    message.region.address = (void *)bytes;
    message.region.size = count;
    message.region.deallocate = FALSE;
    message.region.copy = MACH_MSG_VIRTUAL_COPY;
    message.region.type = MACH_MSG_OOL_DESCRIPTOR;
    message.ndr = NDR_record;
    message.region_length = count;
    message.window_count = 1;
    message.window = window;
    // Only a transport result. The fixture independently checks actual pixels and restoration.
    return mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(message), 0,
                    MACH_PORT_NULL, 200, MACH_PORT_NULL);
#endif
}
