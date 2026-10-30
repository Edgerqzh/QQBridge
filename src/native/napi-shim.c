#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

/* WSL can pipe crash dumps even when ulimit -c is zero. Apply only to this
 * dedicated native host, without changing any machine-wide crash settings. */
__attribute__((constructor)) static void qqbridge_disable_core_dumps(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    fputs("QQBridge: unable to disable native host crash dumps.\n", stderr);
    _exit(78);
  }
}

/*
 * Experimental registration compatibility for the observed Linux QQ
 * 3.2.34-53644 wrapper.node, tested in Node 24.22.2 on Debian 13 x64.
 * This is an independently written symbol bridge, not a QQ implementation.
 * Export enumeration succeeded. Account/session APIs have not been verified.
 * No Tencent binary or source is included in this project.
 */
void qq_magic_napi_register(void *module) {
  typedef void (*register_function)(void *);
  register_function register_module = (register_function)dlsym(RTLD_DEFAULT, "napi_module_register");
  if (!register_module) {
    fputs("QQBridge: host has no napi_module_register symbol.\n", stderr);
    abort();
  }
  register_module(module);
}
