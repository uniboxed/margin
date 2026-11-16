// Private WindowServer filter catalog experiment; research only, never linked into Margin.
// No windows, target processes, preferences, rights grants or display filters are changed.
#import <AppKit/AppKit.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <sys/sysctl.h>

static void emit(NSDictionary *row) {
    puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row
        options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding].UTF8String);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        setbuf(stdout, NULL);
        if (argc != 2 || strcmp(argv[1], "--run")) {
            emit(@{@"plan": @"Create and immediately release two known SkyLight filter types on this process's own connection, then test three mask/crop filter names. No windows, app launches, preferences, display filters or rights grants. Build/UUID/ABI gated to 25G342 arm64."});
            return 0;
        }
#if !defined(__arm64__)
        emit(@{@"refused": @"arm64 only"}); return 2;
#endif
        char build[32] = {0}; size_t length = sizeof(build);
        if (sysctlbyname("kern.osversion", build, &length, NULL, 0) || strcmp(build, "25G342")) {
            emit(@{@"refused": @"build differs"}); return 2;
        }
        void *sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW);
        if (!sky) { emit(@{@"refused": @"SkyLight unavailable"}); return 2; }
        const struct mach_header_64 *header = NULL;
        for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
            NSString *path = @(_dyld_get_image_name(i));
            if ([path.lastPathComponent isEqual:@"SkyLight"] && [path containsString:@"SkyLight.framework/"])
                header = (const void *)_dyld_get_image_header(i);
        }
        if (!header) { emit(@{@"refused": @"loaded image missing"}); return 2; }
        NSString *uuid = nil;
        const struct load_command *command = (const void *)(header + 1);
        for (uint32_t i = 0; i < header->ncmds; ++i) {
            if (command->cmd == LC_UUID)
                uuid = [[NSUUID alloc] initWithUUIDBytes:((const struct uuid_command *)command)->uuid].UUIDString;
            command = (const void *)((const uint8_t *)command + command->cmdsize);
        }
        if (![uuid isEqual:@"D422F0A4-1C28-35B7-A6F5-9EB7BBE0801E"]) {
            emit(@{@"refused": @"SkyLight UUID differs", @"uuid": uuid ?: NSNull.null}); return 2;
        }
        typedef uint32_t (*Main)(void);
        typedef int32_t (*Create)(uint32_t, CFStringRef, uint32_t *);
        typedef int32_t (*Release)(uint32_t, uint32_t);
        Main mainConnection = (Main)dlsym(sky, "SLSMainConnectionID");
        Create create = (Create)dlsym(sky, "SLSNewCIFilterByName");
        Release release = (Release)dlsym(sky, "SLSReleaseCIFilter");
        if (!mainConnection || !create || !release) { emit(@{@"refused": @"symbol missing"}); return 2; }
        uint32_t cid = mainConnection();
        emit(@{@"build": @(build), @"uuid": uuid, @"connection": @(cid), @"pid": @(getpid())});
        for (NSString *name in @[@"CIColorInvert", @"CIShapedWaterRipple", @"CIColorMatrix", @"CIBlendWithAlphaMask", @"CICrop"]) {
            uint32_t filter = 0;
            int32_t result = create(cid, (__bridge CFStringRef)name, &filter);
            int32_t released = filter ? release(cid, filter) : -1;
            emit(@{@"filter": name, @"createResult": @(result), @"identifier": @(filter), @"releaseResult": @(released)});
            BOOL known = [name isEqual:@"CIColorInvert"] || [name isEqual:@"CIShapedWaterRipple"];
            if ((known && (result != 0 || filter == 0 || released != 0)) ||
                (!known && (result == 0 || filter != 0))) {
                emit(@{@"refused": @"catalog differs from traced implementation; stop"}); return 2;
            }
        }
        emit(@{@"complete": @YES, @"allAllocatedFiltersReleased": @YES});
    }
    return 0;
}
