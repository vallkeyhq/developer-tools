#ifndef PHP_VALLKEY_H
#define PHP_VALLKEY_H

extern zend_module_entry vallkey_module_entry;
#define phpext_vallkey_ptr &vallkey_module_entry

#define PHP_VALLKEY_VERSION "0.1.0"

#if defined(ZTS) && defined(COMPILE_DL_VALLKEY)
ZEND_TSRMLS_CACHE_EXTERN()
#endif

#endif
