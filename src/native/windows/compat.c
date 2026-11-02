#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <objbase.h>
#include <stddef.h>
#include "host-imports.h"

/* Independently implemented imports for the pinned Windows addon. No vendor
 * binary is patched. The owner runs exactly one Node environment per process. */
void* qqbridge_targets[QQBRIDGE_IMPORT_COUNT];
static volatile LONG closing = 0;
static volatile LONG registered = 0;
static volatile LONG owns_com = 0;
static void* initial_isolate = NULL;

typedef void* (*get_isolate)(void);
typedef int (*add_hook)(void*, void (*)(void*), void*);
typedef int (*make_fn)(void*, const char*, size_t, void* (*)(void*,void*), void*, void**);
typedef int (*set_prop)(void*, void*, const char*, void*);
typedef int (*get_bool)(void*, int, void**);
typedef int (*throw_error)(void*, const char*, const char*);

static BOOL env_stopping(void* isolate) {
  return InterlockedCompareExchange(&closing, 0, 0) != 0 || isolate != initial_isolate;
}
static void cleanup(void* ignored) {
  InterlockedExchange(&closing, 1);
  if (InterlockedExchange(&owns_com, 0)) CoUninitialize();
}
static void* close_fn(void* env, void* info) {
  InterlockedExchange(&closing, 1);
  return NULL;
}
static void* pump_fn(void* env, void* info) {
  MSG message;
  int running = 1;
  for (int count = 0; count < 64 && PeekMessageW(&message, NULL, 0, 0, PM_REMOVE); count++) {
    if (message.message == WM_QUIT) { running = 0; break; }
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  void* value = NULL;
  ((get_bool)GetProcAddress(GetModuleHandleW(NULL), "napi_get_boolean"))(env, running, &value);
  return value;
}
__declspec(dllexport) void* napi_register_module_v1(void* env, void* exports) {
  HMODULE host = GetModuleHandleW(NULL);
  if (InterlockedCompareExchange(&registered, 1, 0) != 0) {
    ((throw_error)GetProcAddress(host, "napi_throw_error"))(env, NULL, "Only one native environment is supported per process.");
    return NULL;
  }
  HRESULT result = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  if (result == S_OK || result == S_FALSE) InterlockedExchange(&owns_com, 1);
  initial_isolate = ((get_isolate)GetProcAddress(host, "?GetCurrent@Isolate@v8@@SAPEAV12@XZ"))();
  ((add_hook)GetProcAddress(host, "napi_add_env_cleanup_hook"))(env, cleanup, NULL);
  void* function = NULL;
  ((make_fn)GetProcAddress(host, "napi_create_function"))(env, "close", 5, close_fn, NULL, &function);
  ((set_prop)GetProcAddress(host, "napi_set_named_property"))(env, exports, "close", function);
  ((make_fn)GetProcAddress(host, "napi_create_function"))(env, "pump", 4, pump_fn, NULL, &function);
  ((set_prop)GetProcAddress(host, "napi_set_named_property"))(env, exports, "pump", function);
  return exports;
}
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  if (reason != DLL_PROCESS_ATTACH) return TRUE;
  DisableThreadLibraryCalls(instance);
  HMODULE host = GetModuleHandleW(NULL);
  for (int index = 0; index < QQBRIDGE_IMPORT_COUNT; index++) {
    if (index == QQBRIDGE_STOPPING_INDEX) { qqbridge_targets[index] = env_stopping; continue; }
    const char* name = index == QQBRIDGE_REGISTER_INDEX ? "napi_module_register" : names[index];
    qqbridge_targets[index] = (void*)GetProcAddress(host, name);
    if (!qqbridge_targets[index]) return FALSE;
  }
  return TRUE;
}
