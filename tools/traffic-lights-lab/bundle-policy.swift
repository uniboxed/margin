// Read-only, exact-build decoding of the requirement referenced by AXBBundleManager.
// The cache-relative offset is evidence for this build, not a portable API contract.
import AppKit
import Security
import Darwin

var size = 0
sysctlbyname("kern.osversion", nil, &size, nil, 0)
var build = [CChar](repeating: 0, count: size)
sysctlbyname("kern.osversion", &build, &size, nil, 0)
guard String(cString: build) == "25G342", CommandLine.arguments.contains("--run") else {
    print("Read-only requirement decoder; requires --run on 25G342 arm64. No windows or mutations.")
    exit(0)
}
#if !arch(arm64)
fatalError("arm64 cache only")
#endif
let handle = dlopen("/System/Library/PrivateFrameworks/AccessibilityBundles.framework/AccessibilityBundles", RTLD_NOW)!
var info = Dl_info()
precondition(dladdr(dlsym(handle, "AXBBundleManagerLoadAXBundles"), &info) != 0)
let data = Data(bytes: info.dli_fbase.advanced(by: 0x6588), count: 16)
let hex = data.map { String(format: "%02x", $0) }.joined()
precondition(hex == "fade0c00000000100000000100000003", "cache data differs; stop")
var requirement: SecRequirement?
precondition(SecRequirementCreateWithData(data as CFData, [], &requirement) == errSecSuccess)
var text: CFString?
precondition(SecRequirementCopyString(requirement!, [], &text) == errSecSuccess)
print("requirement bytes: \(hex); decoded: \(text!); image: \(String(cString: info.dli_fname))")
