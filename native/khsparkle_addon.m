// Node-API bridge to the shared Sparkle shim (libkhsparkle.a). The Electron main
// process has no native target, so this .node is how it reaches the C surface.
#include <node_api.h>
#include <stdlib.h>
#include "khsparkle.h"

static napi_threadsafe_function g_state_cb = NULL;

static void state_changed(int state) {
  if (!g_state_cb) return;
  int *value = malloc(sizeof(int));
  if (!value) return;
  *value = state;
  napi_call_threadsafe_function(g_state_cb, value, napi_tsfn_nonblocking);
}

static void call_js(napi_env env, napi_value js_cb, void *context, void *data) {
  (void)context;
  int *value = data;
  if (env != NULL && js_cb != NULL) {
    napi_value arg, undefined;
    napi_create_int32(env, *value, &arg);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, js_cb, 1, &arg, NULL);
  }
  free(value);
}

static napi_value Start(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_int32(env, kh_sparkle_start(), &out);
  return out;
}

static napi_value LastError(napi_env env, napi_callback_info info) {
  (void)info;
  const char *reason = kh_sparkle_last_error();
  napi_value out;
  napi_create_string_utf8(env, reason ? reason : "", NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value State(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_int32(env, kh_sparkle_state(), &out);
  return out;
}

static napi_value SetStateCallback(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype type = napi_undefined;
  if (argc > 0) napi_typeof(env, argv[0], &type);

  if (g_state_cb) {
    napi_release_threadsafe_function(g_state_cb, napi_tsfn_abort);
    g_state_cb = NULL;
  }
  if (type != napi_function) {
    kh_sparkle_set_state_callback(NULL);
    return NULL;
  }

  napi_value name;
  napi_create_string_utf8(env, "khsparkle-state", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], NULL, name, 0, 1, NULL, NULL, NULL,
                                      call_js, &g_state_cb) != napi_ok) {
    g_state_cb = NULL;
    kh_sparkle_set_state_callback(NULL);
    return NULL;
  }
  napi_unref_threadsafe_function(env, g_state_cb);
  kh_sparkle_set_state_callback(state_changed);
  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
    {"start", NULL, Start, NULL, NULL, NULL, napi_default, NULL},
    {"lastError", NULL, LastError, NULL, NULL, NULL, napi_default, NULL},
    {"state", NULL, State, NULL, NULL, NULL, napi_default, NULL},
    {"setStateCallback", NULL, SetStateCallback, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
