// Project-owned Node-API bridge. No Pi/upstream package patches or filesystem writes.
// macOS F_GETPATH asks the kernel about an already-open descriptor, not a supplied filename.
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <string.h>
#include <sys/param.h>
#ifndef __APPLE__
#error This backend must be built with the macOS SDK.
#endif

static napi_value descriptor_path(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    double number;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_double(env, argv[0], &number) != napi_ok || !isfinite(number) ||
        number < 0 || number > INT_MAX || number != (double)(int)number) {
        napi_throw_type_error(env, "ERR_INVALID_FD", "Expected one nonnegative integer file descriptor");
        return NULL;
    }
    char name[MAXPATHLEN] = {0};
    if (fcntl((int)number, F_GETPATH, name) == -1) {
        const char *code = errno == EBADF ? "EBADF" : errno == ENOENT ? "ENOENT" :
                           errno == EACCES ? "EACCES" : "ERR_FD_PATH";
        napi_throw_error(env, code, "Cannot resolve the open file descriptor");
        return NULL;
    }
    const char *end = memchr(name, '\0', sizeof(name));
    if (!end || name[0] != '/') {
        napi_throw_error(env, "ERR_FD_PATH", "Kernel returned an invalid descriptor path");
        return NULL;
    }
    napi_value result;
    if (napi_create_string_utf8(env, name, (size_t)(end - name), &result) != napi_ok) return NULL;
    return result;
}
NAPI_MODULE_INIT() {
    napi_value fn;
    if (napi_create_function(env, "descriptorPath", NAPI_AUTO_LENGTH, descriptor_path, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "descriptorPath", fn) != napi_ok) return NULL;
    return exports;
}
