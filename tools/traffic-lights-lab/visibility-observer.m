// Independent AX notification instrument, not a detector input or pixel reader.
#define main archivedMetadataProbeMain
#include "ax-button-visibility.m"
#undef main
static NSUInteger eventCount;
static void observed(AXObserverRef observer,AXUIElementRef element,CFStringRef name,void *context){
    (void)observer;(void)element;eventCount++;emit(@{@"stage":@"AX-event",@"name":(__bridge NSString *)name,@"scope":@((uintptr_t)context),@"uptime":@(NSProcessInfo.processInfo.systemUptime)});
}
int main(int argc,const char **argv){@autoreleasepool{
    setbuf(stdout,NULL);if(argc!=3||strcmp(argv[1],"--run")){emit(@{@"plan":@"--run OWNED_ROOT: read owned fixture identity, register AX notifications on application, window and all three controls, service CFRunLoop until own stop file or 20s. No mutation, polling visibility or capture."});return 0;}
    root=@(argv[2]);require([root containsString:@"/test-results/button-visibility-recorded-"]&&[NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@".owned-fixture"]],@"not owned observer root");require(AXIsProcessTrusted(),@"AX absent");alarm(25);
    char build[32]={0};size_t buildLength=sizeof(build);require(!sysctlbyname("kern.osversion",build,&buildLength,NULL,0)&&!strcmp(build,"26B131"),@"requires inspected build 26B131");
    NSDictionary *ready=load(@"ready.json");require(ready!=nil,@"owned fixture not ready");pid_t pid=[ready[@"pid"] intValue];uint32_t wid=[ready[@"window"] unsignedIntValue];
    getWindowID=dlsym(RTLD_DEFAULT,"_AXUIElementGetWindow");require(getWindowID!=NULL,@"window SPI absent");AXUIElementRef app=AXUIElementCreateApplication(pid),window=exactWindow(app,wid);AXObserverRef observer=NULL;
    require(AXObserverCreate(pid,observed,&observer)==0,@"AX observer unavailable");CFRunLoopAddSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(observer),kCFRunLoopDefaultMode);
    NSMutableArray *elements=[NSMutableArray arrayWithObjects:(__bridge id)app,(__bridge id)window,nil];
    for(NSString *key in @[@"AXCloseButton",@"AXMinimizeButton",@"AXZoomButton"]){CFTypeRef value=NULL;require(axRead(window,key,&value)==0&&value&&CFGetTypeID(value)==AXUIElementGetTypeID(),@"owned control absent");[elements addObject:(__bridge id)value];CFRelease(value);}
    NSUInteger scope=0;
    for(id element in elements){scope++;
        for(NSString *name in @[@"AXLayoutChanged",@"AXValueChanged",@"AXUIElementDestroyed",@"AXCreated",@"AXMoved",@"AXWindowResized",@"AXFocusedUIElementChanged",@"AXSelectedChildrenChanged"]){
            AXError e=AXObserverAddNotification(observer,(__bridge AXUIElementRef)element,(__bridge CFStringRef)name,(void *)(uintptr_t)scope);
            emit(@{@"stage":@"registration",@"scope":@(scope),@"name":name,@"error":@(e)});
        }
    }
    save(@"observer.ready",@{@"ready":@YES,@"pid":@(getpid())});double end=NSProcessInfo.processInfo.systemUptime+20;
    while(end>NSProcessInfo.processInfo.systemUptime&&![NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@"observer.stop"]])CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.02,false);
    emit(@{@"stage":@"observer-complete",@"pid":@(getpid()),@"events":@(eventCount)});
    CFRunLoopRemoveSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(observer),kCFRunLoopDefaultMode);CFRelease(observer);CFRelease(window);CFRelease(app);return 0;
}}
