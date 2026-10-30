PHP_ARG_ENABLE([vallkey],
  [whether to enable Vallkey],
  [AS_HELP_STRING([--enable-vallkey], [Send requests that carry a Vallkey ghost key to Vallkey])],
  [no])

if test "$PHP_VALLKEY" != "no"; then
  PHP_NEW_EXTENSION(vallkey, vallkey.c, $ext_shared)
fi
