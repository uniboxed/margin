// Disposable target and independent ground truth, never linked into the detector.
#define main archivedMetadataProbeMain
#include "ax-button-visibility.m"
#undef main
#include <sys/resource.h>

@interface VisibilityWindow : NSWindow
@property BOOL adversarialAX;
@property NSArray<NSAccessibilityElement *> *nodes;
@end
@implementation VisibilityWindow
- (id)accessibilityCloseButton{return self.adversarialAX?self.nodes[0]:[super accessibilityCloseButton];}
- (id)accessibilityMinimizeButton{return self.adversarialAX?self.nodes[1]:[super accessibilityMinimizeButton];}
- (id)accessibilityZoomButton{return self.adversarialAX?self.nodes[2]:[super accessibilityZoomButton];}
- (id)accessibilityHitTest:(NSPoint)p{
    if(self.adversarialAX)for(NSAccessibilityElement *node in self.nodes)if(NSPointInRect(p,node.accessibilityFrame))return node;
    return [super accessibilityHitTest:p];
}
@end
static double processCPU(void){struct rusage r;getrusage(RUSAGE_SELF,&r);return r.ru_utime.tv_sec+r.ru_utime.tv_usec/1e6+r.ru_stime.tv_sec+r.ru_stime.tv_usec/1e6;}
int main(int argc,const char **argv){@autoreleasepool{
    setbuf(stdout,NULL);
    if(argc!=4||strcmp(argv[1],"--run")){emit(@{@"plan":@"--run OWNED_ROOT visibility|custom|motion|idle|events|group. Disposable target only; independent native truth, optional movement notification positives. Custom mode deliberately retains AX hits while pixels hide. No capture or detector inputs."});return 0;}
    root=@(argv[2]);NSString *mode=@(argv[3]);
    char build[32]={0};size_t buildLength=sizeof(build);require(!sysctlbyname("kern.osversion",build,&buildLength,NULL,0)&&!strcmp(build,"26B131"),@"requires inspected build 26B131");
    require([root containsString:@"/test-results/button-visibility-recorded-"]&&[NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@".owned-fixture"]],@"not owned stimulus root");
    require([@[@"visibility",@"custom",@"motion",@"idle",@"group",@"events"] containsObject:mode],@"bad stimulus mode");alarm(55);
    previous=NSWorkspace.sharedWorkspace.frontmostApplication;
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];[NSApp finishLaunching];
    VisibilityWindow *window=[[VisibilityWindow alloc]initWithContentRect:NSMakeRect(220,730,640,400) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Disposable visibility test";window.contentView.wantsLayer=YES;window.contentView.layer.backgroundColor=[NSColor colorWithSRGBRed:0.05 green:0.70 blue:0.76 alpha:1].CGColor;
    NSWindow *backdrop=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,620,1100,820) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    backdrop.releasedWhenClosed=NO;backdrop.opaque=YES;backdrop.backgroundColor=[NSColor colorWithCalibratedRed:0.16 green:0.18 blue:0.22 alpha:1];backdrop.ignoresMouseEvents=YES;[backdrop orderFront:nil];
    [window makeKeyAndOrderFront:nil];[NSApp activate];pump(0.3);
    if([mode isEqual:@"custom"]){NSMutableArray *nodes=NSMutableArray.array;
        for(NSUInteger i=0;i<3;i++){NSButton *b=nativeButton(window,i);NSRect r=[window convertRectToScreen:[b convertRect:b.bounds toView:nil]];
            NSAccessibilityElement *node=[NSAccessibilityElement accessibilityElementWithRole:NSAccessibilityButtonRole frame:r label:@"Deliberate AX/render mismatch" parent:window];
            node.accessibilityElement=YES;node.accessibilitySubrole=@[NSAccessibilityCloseButtonSubrole,NSAccessibilityMinimizeButtonSubrole,NSAccessibilityZoomButtonSubrole][i];node.accessibilityEnabled=YES;[nodes addObject:node];
        }window.nodes=nodes;window.adversarialAX=YES;
    }
    void *handle=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW);uint32_t(*mainCID)(void)=dlsym(handle,"SLSMainConnectionID");int(*bounds)(uint32_t,uint32_t,CGRect *)=dlsym(handle,"SLSGetWindowBounds");require(mainCID&&bounds,@"stimulus metadata SPI absent");uint32_t cid=mainCID();
    int(*psnForCID)(uint32_t,void *)=dlsym(handle,"SLSGetConnectionPSN");int(*front)(void *,uint32_t,uint32_t)=dlsym(handle,"_SLPSSetFrontProcessWithOptions");uint32_t psn[2]={0,0};
    require(psnForCID&&front&&psnForCID(cid,psn)==0&&front(psn,(uint32_t)window.windowNumber,0x200)==0,@"owned fixture focus request failed");
    int(*move)(uint32_t,uint32_t,const CGPoint *)=dlsym(handle,"SLSMoveWindow");CGPoint zero=CGPointZero;
    require(move&&move(cid,(uint32_t)backdrop.windowNumber,&zero)==0,@"owned backdrop origin failed");
    double activationEnd=NSProcessInfo.processInfo.systemUptime+2.5;
    while(!NSApp.active&&activationEnd>NSProcessInfo.processInfo.systemUptime)pump(0.02);
    [window makeMainWindow];[window makeKeyAndOrderFront:nil];
    while(!window.keyWindow&&activationEnd>NSProcessInfo.processInfo.systemUptime)pump(0.02);
    emit(@{@"stage":@"activation-check",@"active":@(NSApp.active),@"key":@(window.keyWindow),@"frontPID":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)});
    // Idle trials measure AX RPC/CPU only, and group trials measure model bounds;
    // neither makes rendered-visibility claims. Keep strict key gating for video.
    require([mode isEqual:@"group"]||(NSApp.active&&([@[@"idle",@"events"] containsObject:mode]||window.keyWindow)),@"owned fixture not active/key; stop before recording");
    void(^truth)(NSString *)=^(NSString *phase){NSMutableDictionary *row=[nativeTruth(window) mutableCopy];CGRect r=CGRectZero;require(bounds(cid,(uint32_t)window.windowNumber,&r)==0,@"stimulus bounds absent");row[@"stage"]=@"native-truth";row[@"phase"]=phase;row[@"mode"]=mode;row[@"uptime"]=@(NSProcessInfo.processInfo.systemUptime);row[@"serverBounds"]=@[@(r.origin.x),@(r.origin.y),@(r.size.width),@(r.size.height)];row[@"contentHeight"]=@(window.contentView.bounds.size.height);emit(row);};
    save(@"ready.json",@{@"pid":@(getpid()),@"window":@(window.windowNumber)});truth(@"initial");
    NSString *startFile=[root stringByAppendingPathComponent:@"stimulus.start"],*stopFile=[root stringByAppendingPathComponent:@"stimulus.stop"];
    double end=NSProcessInfo.processInfo.systemUptime+35;while(![NSFileManager.defaultManager fileExistsAtPath:startFile]&&end>NSProcessInfo.processInfo.systemUptime)pump(0.01);
    require([NSFileManager.defaultManager fileExistsAtPath:startFile],@"stimulus start timeout");
    double start=NSProcessInfo.processInfo.systemUptime,cpuStart=processCPU(),lastTruth=0;NSInteger lastPhase=-1;BOOL idle=[mode isEqual:@"idle"],motion=[mode isEqual:@"motion"]||[mode isEqual:@"group"];
    for(;;){double t=NSProcessInfo.processInfo.systemUptime-start;if([NSFileManager.defaultManager fileExistsAtPath:stopFile]||t>(idle?35:motion?5.5:9.6))break;
        NSInteger phase=(NSInteger)(t/0.8);NSString *name=@"shown";
        if(!idle&&!motion&&phase!=lastPhase){
            if([mode isEqual:@"events"]&&(phase==2||phase==3))[window setFrameOrigin:NSMakePoint(window.frame.origin.x+(phase==2?12:-12),window.frame.origin.y)];
            for(NSUInteger i=0;i<3;i++){NSButton *b=nativeButton(window,i);hide(b,NO);b.alphaValue=1;b.enabled=YES;reveal(b,@1);}
            if(phase==1||phase==7){name=@"hidden";for(NSUInteger i=0;i<3;i++)hide(nativeButton(window,i),YES);}
            else if(phase==3){name=@"alpha-zero";for(NSUInteger i=0;i<3;i++)nativeButton(window,i).alphaValue=0;}
            else if(phase==4)name=@"fade-out";
            else if(phase==5)name=@"fade-in";
            else if(phase==6){name=@"disabled";for(NSUInteger i=0;i<3;i++)nativeButton(window,i).enabled=NO;}
            else if(phase==9){name=@"only-close";for(NSUInteger i=1;i<3;i++)hide(nativeButton(window,i),YES);}
            [window displayIfNeeded];truth(name);lastPhase=phase;
        }
        if(!idle&&!motion&&(phase==4||phase==5)){
            double amount=fmin(1,fmax(0,(t-phase*0.8)/0.6));if(phase==4)amount=1-amount;
            for(NSUInteger i=0;i<3;i++)reveal(nativeButton(window,i),@(amount));[window displayIfNeeded];
        }
        if(motion&&t>=1&&t<4.5){double f=(t-1)/3.5;[window setFrameOrigin:NSMakePoint(220+65-65*cos(f*16*M_PI),730+40*sin(f*2*M_PI))];}
        if(t-lastTruth>=1.0/60){truth(motion?@"motion":idle?@"idle":@"sample");lastTruth=t;}
        pump(0.012);[NSThread sleepForTimeInterval:0.002];
    }
    truth(@"final");double elapsed=NSProcessInfo.processInfo.systemUptime-start;
    emit(@{@"stage":@"stimulus-complete",@"pid":@(getpid()),@"elapsedSeconds":@(elapsed),@"processCPUSeconds":@(processCPU()-cpuStart)});
    save(@"stimulus.done",@{@"complete":@YES});end=NSProcessInfo.processInfo.systemUptime+8;
    while(![NSFileManager.defaultManager fileExistsAtPath:stopFile]&&end>NSProcessInfo.processInfo.systemUptime)pump(0.01);
    [window close];[backdrop close];if(previous)[previous activateWithOptions:0];return 0;
}}
