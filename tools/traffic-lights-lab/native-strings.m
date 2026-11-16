// Read-only inspection of AppKit constant strings; no windows, preferences or target processes.
#import <AppKit/AppKit.h>
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#include <sys/sysctl.h>
#include <objc/runtime.h>

int main(int argc, const char **argv) {
    @autoreleasepool {
        char build[32] = {0}; size_t count = sizeof(build);
        if (argc != 2 || (strcmp(argv[1], "--run") && strcmp(argv[1], "--all-constants") && strcmp(argv[1], "--selectors") && strcmp(argv[1], "--protocols") && strcmp(argv[1], "--skylight")) || sysctlbyname("kern.osversion", build, &count, NULL, 0) || strcmp(build, "25G342")) {
            puts("Read-only inspection; --run for selected AppKit constants, --all-constants for its complete address map, --selectors for button methods, --skylight for selected filter/right constants, or --protocols on 25G342. No windows or settings changed."); return 0;
        }
        (void)[NSWindow class];
        if (!strcmp(argv[1], "--selectors")) {
            NSDictionary *queries = @{
                @"NSThemeFrame": @[@"_setButtonsShown:", @"_setButtonHidingView:", @"setButtonRevealAmount:", @"_wantsLeftHandButtons", @"_canFloatForTabsOrTitlebar:"],
                @"NSWindow": @[@"_findStandardWindowButton:", @"setStandardWindowTitleButtonsAlphaValue:", @"setTitlebarHidden:", @"setStandardWindowButtonGroupOffset:", @"accessibilitySetOverrideValue:forAttribute:", @"accessibilityIsCloseButtonAttributeSettable", @"accessibilityIsMinimizeButtonAttributeSettable", @"accessibilityIsZoomButtonAttributeSettable"],
                @"NSView": @[@"_setHidden:setNeedsDisplay:"]
            };
            for (NSString *name in [queries.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
                Class cls = NSClassFromString(name);
                for (NSString *selector in queries[name]) {
                    Method method = cls ? class_getInstanceMethod(cls, NSSelectorFromString(selector)) : NULL;
                    NSDictionary *row = @{@"class": name, @"selector": selector, @"available": @(method != NULL),
                        @"encoding": method ? @(method_getTypeEncoding(method)) : NSNull.null};
                    puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding].UTF8String);
                }
            }
            return 0;
        }
        if (!strcmp(argv[1], "--protocols")) {
            unsigned int protocolCount = 0;
            Protocol *__unsafe_unretained *protocols = objc_copyProtocolList(&protocolCount);
            for (unsigned int i = 0; i < protocolCount; ++i) {
                NSString *name = @(protocol_getName(protocols[i]));
                if (![name containsString:@"ThemeWidget"] && ![name containsString:@"WindowManagement"] && ![name hasPrefix:@"WM"]) continue;
                NSMutableArray *methods = NSMutableArray.array;
                for (int required = 0; required <= 1; ++required) {
                    unsigned int n = 0;
                    struct objc_method_description *list = protocol_copyMethodDescriptionList(protocols[i], required, YES, &n);
                    for (unsigned int j = 0; j < n; ++j) [methods addObject:@{@"selector": NSStringFromSelector(list[j].name), @"encoding": @(list[j].types), @"required": @(required)}];
                    free(list);
                }
                puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:@{@"protocol": name, @"methods": methods} options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding].UTF8String);
            }
            free(protocols); return 0;
        }
        for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
            const char *name = _dyld_get_image_name(i);
            BOOL skyMode = !strcmp(argv[1], "--skylight");
            NSString *target = skyMode ? @"SkyLight" : @"AppKit";
            if (![[@(name) lastPathComponent] isEqual:target] || ![@(name) containsString:[target stringByAppendingString:@".framework/"]]) continue;
            const struct mach_header_64 *header = (const void *)_dyld_get_image_header(i);
            unsigned long sectionSize = 0;
            const uint8_t *section = getsectiondata(header, "__AUTH_CONST", "__cfstring", &sectionSize);
            if (!section) return 2;
            intptr_t slide = _dyld_get_image_vmaddr_slide(i);
            for (uint64_t offset = 0; offset + 32 <= sectionSize; offset += 32) {
                NSString *value = (__bridge NSString *)(const void *)(section + offset);
                BOOL match = !strcmp(argv[1], "--all-constants");
                for (NSString *needle in @[@"Traffic", @"Stoplight", @"WindowCloseButtonFrame", @"WindowMiniaturizeButtonFrame", @"WindowZoomButtonFrame", @"StandardWindowButton", @"HideWindowButtons", @"TitlebarElements", @"AXMimicNativeView", @"OverridesAlwaysTakePrecedence", @"ConvolutionOverride"]) {
                    if ([value rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound) match = YES;
                }
                if (skyMode) {
                    uintptr_t address = (uintptr_t)section + offset - slide;
                    match = address >= 0x1eecf9ed8 && address <= 0x1eecf9f58;
                    if (value.length < 240) {
                        for (NSString *needle in @[@"filter", @"grant", @"rights", @"button", @"titlebar"])
                            if ([value rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound) match = YES;
                    }
                }
                if (!match) continue;
                NSDictionary *row = @{@"image": @(name), @"unslidAddress": [NSString stringWithFormat:@"0x%llx", (unsigned long long)((uintptr_t)section + offset - slide)], @"value": value};
                puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding].UTF8String);
            }
        }
    }
    return 0;
}
