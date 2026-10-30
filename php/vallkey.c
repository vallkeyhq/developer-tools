/* Redirect recognized ghost credentials in supported PHP cURL entry points.
 * See README.md for configuration, ABI requirements and transport boundaries.
 */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include <unistd.h>
#include "php.h"
#include "ext/standard/info.h"
#include "ext/standard/url.h"
#include "ext/standard/base64.h"
#include "zend_smart_str.h"
#include "php_vallkey.h"

/* libcurl's option numbers, the same in every version. */
#define VK_CURLOPT_URL 10002
#define VK_CURLOPT_USERPWD 10005
#define VK_CURLOPT_POSTFIELDS 10015
#define VK_CURLOPT_HTTPHEADER 10023
#define VK_CURLOPT_XOAUTH2_BEARER 10220
#define VK_BODY_MAX (1024 * 1024)
#define VK_HOOK_HEADER "x-vallkey-host"
#define VK_WHO_HEADER "x-vallkey-hook"

/* The platform, from variables each one sets itself. The same list, in the same order, is
 * in every Vallkey hook, so the dashboard names a place the same way in any language. */
static const char *vk_platforms[][2] = {
	{"VERCEL", "vercel"}, {"AWS_LAMBDA_FUNCTION_NAME", "aws-lambda"}, {"ECS_CONTAINER_METADATA_URI_V4", "aws-ecs"},
	{"ECS_CONTAINER_METADATA_URI", "aws-ecs"}, {"FUNCTION_TARGET", "cloud-functions"}, {"K_SERVICE", "cloud-run"},
	{"GAE_APPLICATION", "app-engine"}, {"FUNCTIONS_WORKER_RUNTIME", "azure-functions"}, {"CONTAINER_APP_NAME", "azure-container-apps"},
	{"WEBSITE_SITE_NAME", "azure-app-service"}, {"RAILWAY_PROJECT_ID", "railway"}, {"RENDER", "render"}, {"FLY_APP_NAME", "fly"},
	{"DYNO", "heroku"}, {"NETLIFY", "netlify"}, {"KOYEB_APP_NAME", "koyeb"}, {"GITHUB_ACTIONS", "github-actions"},
	{"GITLAB_CI", "gitlab-ci"}, {"KUBERNETES_SERVICE_HOST", "kubernetes"},
};
static char vk_who[200]; /* "php/<version>; runtime=…; platform=…; env=…", made once at startup */

static int vk_env_name(const char *s)
{
	size_t n = 0;
	if (!s) return 0;
	for (; s[n]; n++) {
		char c = s[n];
		if (n >= 40 || !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return 0;
	}
	return n > 0;
}

static void vk_make_who(void)
{
	const char *platform = NULL, *env = getenv("VALLKEY_ENV");
	size_t i;
	int n;
	for (i = 0; i < sizeof(vk_platforms) / sizeof(vk_platforms[0]); i++) {
		const char *v = getenv(vk_platforms[i][0]);
		if (v && *v) {
			platform = vk_platforms[i][1];
			break;
		}
	}
	if (!platform && access("/.dockerenv", F_OK) == 0) platform = "docker";
	n = snprintf(vk_who, sizeof(vk_who), "php/%s; runtime=%s", PHP_VALLKEY_VERSION, PHP_VERSION);
	if (platform && n > 0 && (size_t) n < sizeof(vk_who)) n += snprintf(vk_who + n, sizeof(vk_who) - n, "; platform=%s", platform);
	if (vk_env_name(env) && n > 0 && (size_t) n < sizeof(vk_who)) snprintf(vk_who + n, sizeof(vk_who) - n, "; env=%s", env);
}

ZEND_BEGIN_MODULE_GLOBALS(vallkey)
	HashTable *handles; /* curl handle id => vk_handle, for the current request */
ZEND_END_MODULE_GLOBALS(vallkey)

ZEND_DECLARE_MODULE_GLOBALS(vallkey)
#define VK_G(v) ZEND_MODULE_GLOBALS_ACCESSOR(vallkey, v)

typedef struct {
	zend_string *url;
	zval headers; /* the CURLOPT_HTTPHEADER array, or undef */
	zend_string *userpwd;
	zend_string *bearer;
	zend_string *body;
} vk_handle;

static zif_handler orig_init, orig_setopt, orig_setopt_array, orig_exec, orig_multi_add, orig_copy, orig_reset;
static int vk_on = 0;

/* ---- what is kept for each handle ---- */

static void vk_handle_dtor(zval *zv)
{
	vk_handle *h = Z_PTR_P(zv);
	if (h->url) zend_string_release(h->url);
	if (h->userpwd) zend_string_release(h->userpwd);
	if (h->bearer) zend_string_release(h->bearer);
	if (h->body) zend_string_release(h->body);
	zval_ptr_dtor(&h->headers);
	efree(h);
}

static vk_handle *vk_get(zval *ch, int create)
{
	vk_handle *h;
	if (!VK_G(handles) || Z_TYPE_P(ch) != IS_OBJECT) return NULL;
	h = zend_hash_index_find_ptr(VK_G(handles), Z_OBJ_P(ch)->handle);
	if (!h && create) {
		h = ecalloc(1, sizeof(vk_handle));
		ZVAL_UNDEF(&h->headers);
		zend_hash_index_update_ptr(VK_G(handles), Z_OBJ_P(ch)->handle, h);
	}
	return h;
}

/* A new handle can reuse a freed one's id: what was kept for that one goes. */
static void vk_forget(zval *ch)
{
	if (VK_G(handles) && Z_TYPE_P(ch) == IS_OBJECT) zend_hash_index_del(VK_G(handles), Z_OBJ_P(ch)->handle);
}

static void vk_keep(zend_string **slot, zval *value, size_t max)
{
	if (*slot) {
		zend_string_release(*slot);
		*slot = NULL;
	}
	if (Z_TYPE_P(value) == IS_STRING && (max == 0 || Z_STRLEN_P(value) <= max)) *slot = zend_string_copy(Z_STR_P(value));
}

static void vk_record(zval *ch, zend_long opt, zval *value)
{
	vk_handle *h;
	if (opt != VK_CURLOPT_URL && opt != VK_CURLOPT_HTTPHEADER && opt != VK_CURLOPT_USERPWD && opt != VK_CURLOPT_POSTFIELDS && opt != VK_CURLOPT_XOAUTH2_BEARER) return;
	h = vk_get(ch, 1);
	if (!h) return;
	ZVAL_DEREF(value);
	switch (opt) {
		case VK_CURLOPT_URL: vk_keep(&h->url, value, 0); break;
		case VK_CURLOPT_USERPWD: vk_keep(&h->userpwd, value, 0); break;
		case VK_CURLOPT_XOAUTH2_BEARER: vk_keep(&h->bearer, value, 0); break;
		case VK_CURLOPT_POSTFIELDS: vk_keep(&h->body, value, VK_BODY_MAX); break;
		case VK_CURLOPT_HTTPHEADER:
			zval_ptr_dtor(&h->headers);
			ZVAL_UNDEF(&h->headers);
			if (Z_TYPE_P(value) == IS_ARRAY) ZVAL_ARR(&h->headers, zend_array_dup(Z_ARRVAL_P(value)));
			break;
	}
}

/* ---- finding a ghost key: gk_<provider>_<22>_<43> ---- */

static int vk_key_char(unsigned char c)
{
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}

static int vk_run(const char *s, size_t from, size_t n)
{
	size_t i;
	for (i = 0; i < n; i++) if (!vk_key_char((unsigned char) s[from + i])) return 0;
	return 1;
}

static int vk_has_ghost(const char *s, size_t len)
{
	size_t i, p, letters, j;
	for (i = 0; i + 3 < len; i++) {
		if (s[i] != 'g' || s[i + 1] != 'k' || s[i + 2] != '_') continue;
		for (letters = 0; i + 3 + letters < len && letters < 20 && s[i + 3 + letters] >= 'a' && s[i + 3 + letters] <= 'z'; letters++);
		for (p = 2; p <= letters; p++) {
			j = i + 3 + p;
			if (j + 1 + 22 + 1 + 43 > len) break;
			if (s[j] == '_' && vk_run(s, j + 1, 22) && s[j + 23] == '_' && vk_run(s, j + 24, 43)) return 1;
		}
	}
	return 0;
}

static int vk_ghost_in_header(zend_string *line)
{
	const char *v, *colon;
	zend_string *decoded;
	int found;
	if (vk_has_ghost(ZSTR_VAL(line), ZSTR_LEN(line))) return 1;
	/* Basic credentials: the key is inside the base64. */
	colon = memchr(ZSTR_VAL(line), ':', ZSTR_LEN(line));
	if (!colon) return 0;
	for (v = colon + 1; *v == ' ' || *v == '\t'; v++);
	if (strncasecmp(v, "basic ", 6) != 0) return 0;
	v += 6;
	decoded = php_base64_decode((const unsigned char *) v, ZSTR_VAL(line) + ZSTR_LEN(line) - v);
	if (!decoded) return 0;
	found = vk_has_ghost(ZSTR_VAL(decoded), ZSTR_LEN(decoded));
	zend_string_release(decoded);
	return found;
}

static int vk_ghost_in(vk_handle *h, php_url *u)
{
	zval *line;
	if (u->query) {
		zend_string *q = zend_string_init(ZSTR_VAL(u->query), ZSTR_LEN(u->query), 0);
		size_t n = php_url_decode(ZSTR_VAL(q), ZSTR_LEN(q));
		int found = vk_has_ghost(ZSTR_VAL(q), n);
		zend_string_release(q);
		if (found) return 1;
	}
	if (Z_TYPE(h->headers) == IS_ARRAY) {
		ZEND_HASH_FOREACH_VAL(Z_ARRVAL(h->headers), line) {
			ZVAL_DEREF(line);
			if (Z_TYPE_P(line) == IS_STRING && vk_ghost_in_header(Z_STR_P(line))) return 1;
		} ZEND_HASH_FOREACH_END();
	}
	if (h->userpwd && vk_has_ghost(ZSTR_VAL(h->userpwd), ZSTR_LEN(h->userpwd))) return 1;
	if (h->bearer && vk_has_ghost(ZSTR_VAL(h->bearer), ZSTR_LEN(h->bearer))) return 1;
	return h->body && vk_has_ghost(ZSTR_VAL(h->body), ZSTR_LEN(h->body));
}

/* ---- changing the address ---- */

static void vk_setopt(zval *ch, zend_long opt, zval *value)
{
	zval fname, retval, params[3];
	ZVAL_STRING(&fname, "curl_setopt");
	ZVAL_COPY_VALUE(&params[0], ch);
	ZVAL_LONG(&params[1], opt);
	ZVAL_COPY_VALUE(&params[2], value);
	if (call_user_function(NULL, NULL, &fname, &retval, 3, params) == SUCCESS) zval_ptr_dtor(&retval);
	zval_ptr_dtor(&fname);
}

static zend_long vk_default_port(zend_string *scheme)
{
	return zend_string_equals_literal_ci(scheme, "https") ? 443 : 80;
}

static void vk_redirect(zval *ch)
{
	vk_handle *h;
	php_url *u = NULL, *t = NULL;
	const char *api;
	zend_long port, tport;
	smart_str url = {0}, from = {0};
	zval value, *line;

	if (!vk_on) return;
	h = vk_get(ch, 0);
	if (!h || !h->url) return;
	u = php_url_parse_ex(ZSTR_VAL(h->url), ZSTR_LEN(h->url));
	if (!u || !u->scheme || !u->host || (!zend_string_equals_literal_ci(u->scheme, "https") && !zend_string_equals_literal_ci(u->scheme, "http"))) goto done;
	api = getenv("VALLKEY_API");
	if (!api || !*api) api = "https://api.vallkey.com";
	t = php_url_parse(api);
	if (!t || !t->scheme || !t->host) goto done;
	port = u->port ? u->port : vk_default_port(u->scheme);
	tport = t->port ? t->port : vk_default_port(t->scheme);
	if (zend_string_equals_ci(u->host, t->host) && port == tport) goto done;
	if (!vk_ghost_in(h, u)) goto done;

	smart_str_append(&from, u->host);
	if (port != vk_default_port(u->scheme)) {
		smart_str_appendc(&from, ':');
		smart_str_append_long(&from, port);
	}
	smart_str_0(&from);

	smart_str_append(&url, t->scheme);
	smart_str_appends(&url, "://");
	smart_str_append(&url, t->host);
	if (tport != vk_default_port(t->scheme)) {
		smart_str_appendc(&url, ':');
		smart_str_append_long(&url, tport);
	}
	if (u->path) smart_str_append(&url, u->path);
	else smart_str_appendc(&url, '/');
	if (u->query) {
		smart_str_appendc(&url, '?');
		smart_str_append(&url, u->query);
	}
	smart_str_0(&url);

	if (getenv("VALLKEY_DEBUG") && strcmp(getenv("VALLKEY_DEBUG"), "1") == 0) {
		fprintf(stderr, "[vallkey] %s://%s -> %s://%s\n", ZSTR_VAL(u->scheme), ZSTR_VAL(from.s), ZSTR_VAL(t->scheme), ZSTR_VAL(t->host));
	}

	/* The headers, without a Host naming the provider, and with the address it was for. */
	array_init(&value);
	if (Z_TYPE(h->headers) == IS_ARRAY) {
		ZEND_HASH_FOREACH_VAL(Z_ARRVAL(h->headers), line) {
			ZVAL_DEREF(line);
			if (Z_TYPE_P(line) != IS_STRING) continue;
			if (strncasecmp(Z_STRVAL_P(line), "host:", 5) == 0 || strncasecmp(Z_STRVAL_P(line), VK_HOOK_HEADER ":", sizeof(VK_HOOK_HEADER)) == 0 || strncasecmp(Z_STRVAL_P(line), VK_WHO_HEADER ":", sizeof(VK_WHO_HEADER)) == 0) continue;
			add_next_index_str(&value, zend_string_copy(Z_STR_P(line)));
		} ZEND_HASH_FOREACH_END();
	}
	add_next_index_str(&value, zend_strpprintf(0, VK_HOOK_HEADER ": %s", ZSTR_VAL(from.s)));
	add_next_index_str(&value, zend_strpprintf(0, VK_WHO_HEADER ": %s", vk_who));
	vk_setopt(ch, VK_CURLOPT_HTTPHEADER, &value);
	zval_ptr_dtor(&value);

	ZVAL_STR(&value, url.s);
	vk_setopt(ch, VK_CURLOPT_URL, &value);
	smart_str_free(&url);
	smart_str_free(&from);
done:
	if (u) php_url_free(u);
	if (t) php_url_free(t);
}

/* ---- the curl functions, wrapped ---- */

static ZEND_NAMED_FUNCTION(vk_curl_init)
{
	orig_init(INTERNAL_FUNCTION_PARAM_PASSTHRU);
	if (Z_TYPE_P(return_value) != IS_OBJECT) return;
	vk_forget(return_value);
	if (ZEND_CALL_NUM_ARGS(execute_data) >= 1) vk_record(return_value, VK_CURLOPT_URL, ZEND_CALL_ARG(execute_data, 1));
}

static ZEND_NAMED_FUNCTION(vk_curl_setopt)
{
	orig_setopt(INTERNAL_FUNCTION_PARAM_PASSTHRU);
	if (Z_TYPE_P(return_value) != IS_TRUE || ZEND_CALL_NUM_ARGS(execute_data) < 3) return;
	if (Z_TYPE_P(ZEND_CALL_ARG(execute_data, 2)) == IS_LONG) vk_record(ZEND_CALL_ARG(execute_data, 1), Z_LVAL_P(ZEND_CALL_ARG(execute_data, 2)), ZEND_CALL_ARG(execute_data, 3));
}

static ZEND_NAMED_FUNCTION(vk_curl_setopt_array)
{
	zval *ch, *options, *value;
	zend_ulong opt;
	zend_string *name;
	orig_setopt_array(INTERNAL_FUNCTION_PARAM_PASSTHRU);
	if (Z_TYPE_P(return_value) != IS_TRUE || ZEND_CALL_NUM_ARGS(execute_data) < 2) return;
	ch = ZEND_CALL_ARG(execute_data, 1);
	options = ZEND_CALL_ARG(execute_data, 2);
	ZVAL_DEREF(options);
	if (Z_TYPE_P(options) != IS_ARRAY) return;
	ZEND_HASH_FOREACH_KEY_VAL(Z_ARRVAL_P(options), opt, name, value) {
		if (!name) vk_record(ch, (zend_long) opt, value);
	} ZEND_HASH_FOREACH_END();
}

static ZEND_NAMED_FUNCTION(vk_curl_copy_handle)
{
	vk_handle *src, *dst;
	orig_copy(INTERNAL_FUNCTION_PARAM_PASSTHRU);
	if (Z_TYPE_P(return_value) != IS_OBJECT || ZEND_CALL_NUM_ARGS(execute_data) < 1) return;
	vk_forget(return_value);
	src = vk_get(ZEND_CALL_ARG(execute_data, 1), 0);
	if (!src) return;
	dst = vk_get(return_value, 1);
	if (!dst) return;
	if (src->url) dst->url = zend_string_copy(src->url);
	if (src->userpwd) dst->userpwd = zend_string_copy(src->userpwd);
	if (src->bearer) dst->bearer = zend_string_copy(src->bearer);
	if (src->body) dst->body = zend_string_copy(src->body);
	if (Z_TYPE(src->headers) == IS_ARRAY) ZVAL_ARR(&dst->headers, zend_array_dup(Z_ARRVAL(src->headers)));
}

static ZEND_NAMED_FUNCTION(vk_curl_reset)
{
	orig_reset(INTERNAL_FUNCTION_PARAM_PASSTHRU);
	if (ZEND_CALL_NUM_ARGS(execute_data) >= 1) vk_forget(ZEND_CALL_ARG(execute_data, 1));
}

static ZEND_NAMED_FUNCTION(vk_curl_exec)
{
	if (ZEND_CALL_NUM_ARGS(execute_data) >= 1) vk_redirect(ZEND_CALL_ARG(execute_data, 1));
	orig_exec(INTERNAL_FUNCTION_PARAM_PASSTHRU);
}

static ZEND_NAMED_FUNCTION(vk_curl_multi_add_handle)
{
	if (ZEND_CALL_NUM_ARGS(execute_data) >= 2) vk_redirect(ZEND_CALL_ARG(execute_data, 2));
	orig_multi_add(INTERNAL_FUNCTION_PARAM_PASSTHRU);
}

/* ---- the module ---- */

static zend_function *vk_find(const char *name)
{
	zend_function *f = zend_hash_str_find_ptr(CG(function_table), name, strlen(name));
	return f && f->type == ZEND_INTERNAL_FUNCTION ? f : NULL;
}

static PHP_GINIT_FUNCTION(vallkey)
{
#if defined(ZTS) && defined(COMPILE_DL_VALLKEY)
	ZEND_TSRMLS_CACHE_UPDATE();
#endif
	vallkey_globals->handles = NULL;
}

static PHP_MINIT_FUNCTION(vallkey)
{
	const char *names[] = {"curl_init", "curl_setopt", "curl_setopt_array", "curl_exec", "curl_multi_add_handle", "curl_copy_handle", "curl_reset"};
	zif_handler *originals[] = {&orig_init, &orig_setopt, &orig_setopt_array, &orig_exec, &orig_multi_add, &orig_copy, &orig_reset};
	zif_handler wrappers[] = {vk_curl_init, vk_curl_setopt, vk_curl_setopt_array, vk_curl_exec, vk_curl_multi_add_handle, vk_curl_copy_handle, vk_curl_reset};
	zend_function *found[7];
	const char *off = getenv("VALLKEY_AUTO");
	size_t i;
	if (off && strcmp(off, "0") == 0) return SUCCESS;
	/* All or nothing: without the curl extension there is nothing to do. */
	for (i = 0; i < 7; i++) if (!(found[i] = vk_find(names[i]))) return SUCCESS;
	for (i = 0; i < 7; i++) {
		*originals[i] = found[i]->internal_function.handler;
		found[i]->internal_function.handler = wrappers[i];
	}
	vk_make_who();
	vk_on = 1;
	return SUCCESS;
}

static PHP_RINIT_FUNCTION(vallkey)
{
#if defined(ZTS) && defined(COMPILE_DL_VALLKEY)
	ZEND_TSRMLS_CACHE_UPDATE();
#endif
	if (!vk_on) return SUCCESS;
	ALLOC_HASHTABLE(VK_G(handles));
	zend_hash_init(VK_G(handles), 8, NULL, vk_handle_dtor, 0);
	return SUCCESS;
}

static PHP_RSHUTDOWN_FUNCTION(vallkey)
{
	if (VK_G(handles)) {
		zend_hash_destroy(VK_G(handles));
		FREE_HASHTABLE(VK_G(handles));
		VK_G(handles) = NULL;
	}
	return SUCCESS;
}

static PHP_MINFO_FUNCTION(vallkey)
{
	php_info_print_table_start();
	php_info_print_table_row(2, "Vallkey", vk_on ? "sends requests that carry a ghost key to Vallkey" : "off");
	php_info_print_table_row(2, "Version", PHP_VALLKEY_VERSION);
	php_info_print_table_end();
}

/* Loaded after curl when both are there, so curl's functions exist to wrap. */
static const zend_module_dep vallkey_deps[] = {
	ZEND_MOD_OPTIONAL("curl")
	ZEND_MOD_END
};

zend_module_entry vallkey_module_entry = {
	STANDARD_MODULE_HEADER_EX,
	NULL,
	vallkey_deps,
	"vallkey",
	NULL,
	PHP_MINIT(vallkey),
	NULL,
	PHP_RINIT(vallkey),
	PHP_RSHUTDOWN(vallkey),
	PHP_MINFO(vallkey),
	PHP_VALLKEY_VERSION,
	PHP_MODULE_GLOBALS(vallkey),
	PHP_GINIT(vallkey),
	NULL,
	NULL,
	STANDARD_MODULE_PROPERTIES_EX
};

#ifdef COMPILE_DL_VALLKEY
#if defined(ZTS)
ZEND_TSRMLS_CACHE_DEFINE()
#endif
ZEND_GET_MODULE(vallkey)
#endif
