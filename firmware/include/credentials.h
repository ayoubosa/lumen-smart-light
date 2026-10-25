#pragma once
// Wi-Fi and API secrets. secrets.h is git-ignored; CI builds with the example.

#if __has_include("secrets.h")
#include "secrets.h"
#elif defined(NATHER_CI)
#include "secrets.example.h"
#else
#error "Copy include/secrets.example.h to include/secrets.h and fill in your Wi-Fi details"
#endif
