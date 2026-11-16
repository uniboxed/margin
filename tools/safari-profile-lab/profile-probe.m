// Isolated Safari-profile API research. Never linked into Margin.app.
// This executable never launches Safari, sends Apple Events or calls Accessibility.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <pwd.h>
#include <sys/sysctl.h>
#include <unistd.h>

static void emit(NSDictionary *row) {
    puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row
        options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding].UTF8String);
}

static void require(BOOL condition, NSString *reason) {
    if (!condition) { emit(@{@"refused": reason}); exit(2); }
}

static BOOL deniedOpen(NSString *path, int flags) {
    errno = 0;
    int fd = open(path.fileSystemRepresentation, flags);
    int error = errno;
    if (fd >= 0) close(fd);
    return fd < 0 && (error == EPERM || error == EACCES);
}

@protocol ConfigurationSPI <NSObject>
- (instancetype)initWithCollectionType:(NSInteger)type databasePath:(NSString *)path readonly:(BOOL)readonly createIfNeeded:(BOOL)create;
- (void)setSkipsExternalNotifications:(BOOL)value;
- (void)setStoreOwner:(NSInteger)value;
- (NSString *)databasePath;
@end
@protocol CollectionSPI <NSObject>
- (instancetype)initWithConfiguration:(id)configuration openDatabase:(BOOL)open checkIntegrity:(BOOL)check;
- (NSArray *)profiles;
- (void)waitForPendingChanges;
- (NSError *)error;
@end
@protocol ProfileSPI <NSObject>
- (instancetype)initWithTitle:(NSString *)title symbolImageName:(NSString *)symbol favoritesFolderServerID:(NSString *)favorites;
- (NSString *)title;
- (id)identifier;
- (NSString *)serverID;
@end
@protocol ManagerSPI <NSObject>
- (instancetype)initWithCollection:(id)collection profileDataManager:(id)dataManager;
- (void)appendProfile:(id)profile completionHandler:(void (^)(id))completion;
- (NSArray *)profiles;
- (void)waitForPendingChanges;
@end

static void checkABI(NSString *name, NSString *selector, const char *encoding) {
    Method method = class_getInstanceMethod(NSClassFromString(name), NSSelectorFromString(selector));
    require(method && !strcmp(method_getTypeEncoding(method), encoding), [@"ABI changed: " stringByAppendingString:selector]);
}

static NSArray *profileRows(NSArray *profiles) {
    NSMutableArray *rows = NSMutableArray.array;
    for (id<ProfileSPI> profile in profiles)
        [rows addObject:@{@"title": [profile title] ?: @"", @"identifier": [[profile identifier] description] ?: @"", @"serverID": [profile serverID] ?: @""}];
    return rows;
}

// Read a pinned constant only after verifying it lies in the loaded image's
// __cfstring section. No target process, object construction or service call.
static void inspectCyclerEntitlement(void) {
    const uint64_t address = 0x1F1BFFD50;
    for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
        const char *name = _dyld_get_image_name(i);
        if (!name || !strstr(name, "SafariShared.framework/")) continue;
        const struct mach_header_64 *header = (const void *)_dyld_get_image_header(i);
        require(header->magic == MH_MAGIC_64, @"unexpected image header");
        const struct load_command *command = (const void *)(header + 1);
        for (uint32_t j = 0; j < header->ncmds; ++j) {
            if (command->cmd == LC_SEGMENT_64) {
                const struct segment_command_64 *segment = (const void *)command;
                const struct section_64 *section = (const void *)(segment + 1);
                for (uint32_t k = 0; k < segment->nsects; ++k, ++section) {
                    if (!strcmp(section->sectname, "__cfstring") && address >= section->addr &&
                        address + 32 <= section->addr + section->size) {
                        CFTypeRef value = (const void *)(address + _dyld_get_image_vmaddr_slide(i));
                        require(CFGetTypeID(value) == CFStringGetTypeID(), @"pinned literal changed type");
                        emit(@{@"pinnedConstant": @"cycler listener valueForEntitlement argument",
                            @"unslidAddress": @"0x1F1BFFD50", @"value": (__bridge NSString *)value});
                        return;
                    }
                }
            }
            command = (const void *)((const char *)command + command->cmdsize);
        }
    }
    require(NO, @"pinned literal not found in loaded SafariShared cfstrings");
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        setbuf(stdout, NULL);
        BOOL fixture = argc > 1 && !strcmp(argv[1], "--fixture-create");
        if (argc != 4 || (strcmp(argv[1], "--inspect") && !fixture) || strcmp(argv[2], "--root")) {
            emit(@{@"plan": @"--inspect reads metadata only. --fixture-create exercises native WebBookmarks profile creation in a new owned debug store, with nil profile-directory manager and external notifications disabled; this is not a real Safari profile. Both require --root and confinement controls. Never launches Safari, sends Apple Events, calls Accessibility or grants permissions."});
            return 0;
        }
        alarm(12);
        char build[32] = {0}; size_t length = sizeof(build);
        require(!sysctlbyname("kern.osversion", build, &length, NULL, 0) && !strcmp(build, "25G342"), @"build differs from 25G342");
        NSString *root = [[@(argv[3]) stringByStandardizingPath] stringByResolvingSymlinksInPath];
        require([root containsString:@"/test-results/safari-profiles-"] && [root.lastPathComponent isEqual:@"allowed"], @"root is not a lab fixture");
        NSString *marker = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@".margin-profile-fixture"] encoding:NSUTF8StringEncoding error:nil];
        require([marker isEqual:@"margin-safari-profile-lab 25G342\n"], @"fixture marker missing");
        NSString *canary = [root.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"forbidden.txt"];
        require(deniedOpen(canary, O_RDONLY) && deniedOpen(canary, O_WRONLY), @"confinement controls did not deny canary read/write");
        struct passwd *user = getpwuid(getuid());
        require(user != NULL, @"user home unavailable");
        NSString *realHome = @(user->pw_dir);
        NSArray *safariFiles = @[@"Library/Safari/SafariTabs.db", @"Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db"];
        NSMutableArray *readResults = NSMutableArray.array;
        for (NSString *suffix in safariFiles) {
            NSString *path = [realHome stringByAppendingPathComponent:suffix];
            errno = 0; int fd = open(path.fileSystemRepresentation, O_RDONLY); int error = errno;
            if (fd >= 0) close(fd);
            NSDictionary *row = @{@"protectedReadPath": path, @"opened": @(fd >= 0), @"errno": @(error)};
            emit(row); [readResults addObject:row];
            require(fd < 0 && (error == EPERM || error == EACCES || error == ENOENT), @"live Safari store accessible or unexpected read error; stop before loading SPI");
        }
        emit(@{@"build": @(build), @"pid": @(getpid()), @"liveSafariFilesOpened": @NO, @"protectedReadResults": readResults,
            @"canaryReadWriteDenied": @YES, @"root": root,
            @"permissionModel": @"seatbelt restrictions, not a claim about inherited host TCC grants"});
        void *framework = dlopen("/System/Library/PrivateFrameworks/WebBookmarks.framework/WebBookmarks", RTLD_NOW | RTLD_LOCAL);
        require(framework != NULL, @"WebBookmarks failed to load");
        if (fixture) {
            checkABI(@"WBCollectionConfiguration", @"initWithCollectionType:databasePath:readonly:createIfNeeded:", "@40@0:8q16@24B32B36");
            checkABI(@"WBCollectionConfiguration", @"setStoreOwner:", "v24@0:8q16");
            checkABI(@"WBCollectionConfiguration", @"setSkipsExternalNotifications:", "v20@0:8B16");
            checkABI(@"WBTabCollection", @"initWithConfiguration:openDatabase:checkIntegrity:", "@32@0:8@16B24B28");
            checkABI(@"WBProfile", @"initWithTitle:symbolImageName:favoritesFolderServerID:", "@40@0:8@16@24@32");
            checkABI(@"WBTabGroupManager", @"initWithCollection:profileDataManager:", "@32@0:8@16@24");
            checkABI(@"WBTabGroupManager", @"appendProfile:completionHandler:", "v32@0:8@16@?24");
            NSString *path = [root stringByAppendingPathComponent:@"SafariTabs.db"];
            require(![NSFileManager.defaultManager fileExistsAtPath:path], @"fixture database already exists");
            id<ConfigurationSPI> config = [(id<ConfigurationSPI>)[NSClassFromString(@"WBCollectionConfiguration") alloc]
                initWithCollectionType:1 databasePath:path readonly:NO createIfNeeded:YES];
            // +debugTabCollectionConfiguration explicitly selects storeOwner=1 on
            // this build. Only the constructor's explicit scratch path is used.
            [config setStoreOwner:1]; [config setSkipsExternalNotifications:YES];
            require([[config databasePath] isEqual:path], @"configured store path changed");
            emit(@{@"stage": @"configuration", @"database": path, @"storeOwner": @1, @"externalNotifications": @NO});
            id<CollectionSPI> collection = [(id<CollectionSPI>)[NSClassFromString(@"WBTabCollection") alloc]
                initWithConfiguration:config openDatabase:YES checkIntegrity:YES];
            NSError *error = [collection error];
            emit(@{@"stage": @"collection", @"present": @(collection != nil),
                @"errorDomain": error.domain ?: @"", @"errorCode": @(error.code)});
            // Unlike normal NSError conventions, this getter always constructs
            // the last SQLite result; code 0 means SQLITE_OK, not failure.
            BOOL sqliteOK = [error.domain isEqual:@"com.apple.WebBookmarks.SQLiteError"] && error.code == 0;
            require(collection != nil && (error == nil || sqliteOK), @"fixture collection did not open");
            id<ManagerSPI> manager = [(id<ManagerSPI>)[NSClassFromString(@"WBTabGroupManager") alloc]
                initWithCollection:collection profileDataManager:nil];
            require(manager != nil, @"fixture manager did not initialize");
            emit(@{@"stage": @"before", @"profiles": profileRows([manager profiles])});
            NSString *title = [@"Margin isolated profile " stringByAppendingString:NSUUID.UUID.UUIDString];
            id<ProfileSPI> profile = [(id<ProfileSPI>)[NSClassFromString(@"WBProfile") alloc]
                initWithTitle:title symbolImageName:@"flask" favoritesFolderServerID:nil];
            require(profile != nil, @"profile value did not initialize");
            __block BOOL finished = NO; __block id returned = nil;
            // append's wrapper invokes the caller with a copied WBProfile on
            // success, or nil on failure; checked in its two block bodies.
            [manager appendProfile:profile completionHandler:^(id value) { returned = value; finished = YES; }];
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:6];
            while (!finished && deadline.timeIntervalSinceNow > 0)
                [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
            require(finished && returned != nil, @"fixture append did not complete successfully");
            [manager waitForPendingChanges]; [collection waitForPendingChanges];
            NSArray *after = profileRows([manager profiles]);
            require([[after valueForKey:@"title"] containsObject:title], @"new profile absent from native manager");
            emit(@{@"stage": @"after", @"profiles": after, @"createdTitle": title});
            emit(@{@"complete": @YES, @"isolatedStoreOnly": @YES, @"realSafariProfileCreated": @NO,
                @"profileDirectoryManager": @"nil for fixture isolation"});
            return 0;
        }
        NSArray *classes = @[@"WBCollectionConfiguration", @"WBTabCollection", @"WBProfile", @"WBMutableProfile", @"WBTabGroupManager", @"WebBookmarkCollection", @"WebBookmarkTabCollection", @"WBTabGroupSyncAgentProxy", @"WebBookmarksSettingsGateway"];
        inspectCyclerEntitlement();
        for (NSString *name in @[@"WBTabGroupSyncAgentProtocol", @"WBSCyclerTestTarget", @"WBSCyclerServiceProtocol"]) {
            Protocol *protocol = objc_getProtocol(name.UTF8String);
            require(protocol != nil, [@"missing protocol: " stringByAppendingString:name]);
            for (int required = 0; required < 2; ++required) {
                unsigned count = 0;
                struct objc_method_description *methods = protocol_copyMethodDescriptionList(protocol, required, YES, &count);
                for (unsigned j = 0; j < count; ++j)
                    emit(@{@"protocol": name, @"required": @(required), @"selector": NSStringFromSelector(methods[j].name), @"encoding": @(methods[j].types)});
                free(methods);
            }
        }
        NSArray *needles = @[@"profile", @"initWithCollection", @"initWithConfiguration", @"databasePath", @"waitForPending", @"skipsExternal", @"storeOwner", @"inMemory", @"syncAgent", @"close", @"invalidate"];
        for (NSString *name in classes) {
            Class cls = NSClassFromString(name);
            require(cls != Nil, [@"missing class: " stringByAppendingString:name]);
            for (int meta = 0; meta <= 1; ++meta) {
                unsigned int count = 0;
                Method *methods = class_copyMethodList(meta ? object_getClass(cls) : cls, &count);
                for (unsigned int i = 0; i < count; ++i) {
                    NSString *selector = NSStringFromSelector(method_getName(methods[i]));
                    BOOL selected = [selector hasPrefix:@"init"] || [name isEqual:@"WebBookmarksSettingsGateway"] || [name isEqual:@"WBTabGroupSyncAgentProxy"];
                    for (NSString *needle in needles)
                        if ([selector rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound) selected = YES;
                    if (selected) emit(@{@"class": name, @"classMethod": @(meta), @"selector": selector,
                        @"encoding": @(method_getTypeEncoding(methods[i]))});
                }
                free(methods);
            }
        }
        emit(@{@"complete": @YES, @"instancesCreated": @NO});
    }
    return 0;
}
