// Read-only ABI/permission inspection. No window, pixel capture or TCC request.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
int main(int argc,const char **argv) {
    @autoreleasepool {
        if(argc!=2 || strcmp(argv[1],"--inspect")) { puts("--inspect: print current AX trust and selected native method encodings; no windows or capture");return 0; }
        printf("AXTrusted=%d\n",AXIsProcessTrusted());
        NSDictionary *queries=@{@"NSWindow":@[@"_findStandardWindowButton:"],@"NSView":@[@"_setHidden:setNeedsDisplay:"],
            @"NSThemeWidget":@[@"setRevealAmount:",@"revealAmount",@"isHidden",@"alphaValue"],
            @"_NSThemeWidget":@[@"setRevealAmount:",@"revealAmount"],@"NSThemeFrame":@[@"setButtonRevealAmount:",@"buttonRevealAmount"]};
        for(NSString *name in queries)for(NSString *selector in queries[name]) {
            Method method=class_getInstanceMethod(NSClassFromString(name),NSSelectorFromString(selector));
            printf("%s %s %s\n",name.UTF8String,selector.UTF8String,method?method_getTypeEncoding(method):"absent");
        }
    }
    return 0;
}
