// double_as_float.c — Intercepte les routines soft double de la ROM ESP32
//
// L'ESP32-S3 a un FPU single-precision (float) mais AUCUN FPU double.
// Chaque opération "double" appelle __adddf3/__subdf3 etc. en ROM : ~100+ cycles.
// Via --wrap du linker, on redirige vers des versions float (FPU hardware, ~1 cycle).
//
// Les conversions float↔double sont faites par manipulation de bits (entiers)
// pour éviter tout appel récursif aux routines wrappées.

#include <stdint.h>

// ── Conversion double→float par bits (sans appel lib) ──────────────────────
static inline float _d2f(double d) {
    uint64_t u;
    __builtin_memcpy(&u, &d, sizeof(u));
    uint32_t sign  = (uint32_t)(u >> 63) & 1;
    int32_t  dexp  = (int32_t)((u >> 52) & 0x7FF);
    uint32_t dmant = (uint32_t)(u >> 29) & 0x7FFFFF;
    int32_t  fexp  = dexp - 1023 + 127;
    if (dexp == 0x7FF)    { fexp = 0xFF; dmant = 0; }   // Inf/NaN
    else if (fexp <= 0)   { fexp = 0;    dmant = 0; }   // underflow → 0
    else if (fexp >= 0xFF){ fexp = 0xFF; dmant = 0; }   // overflow → Inf
    uint32_t fb = (sign << 31) | ((uint32_t)fexp << 23) | dmant;
    float result;
    __builtin_memcpy(&result, &fb, sizeof(result));
    return result;
}

// ── Conversion float→double par bits (sans appel lib) ──────────────────────
static inline double _f2d(float f) {
    uint32_t u;
    __builtin_memcpy(&u, &f, sizeof(u));
    uint64_t sign  = (u >> 31) & 1;
    int32_t  fexp  = (int32_t)((u >> 23) & 0xFF);
    uint64_t fmant = u & 0x7FFFFF;
    int32_t  dexp  = (fexp == 0) ? 0 : (fexp == 0xFF ? 0x7FF : fexp - 127 + 1023);
    uint64_t db    = (sign << 63) | ((uint64_t)(uint32_t)dexp << 52) | (fmant << 29);
    double result;
    __builtin_memcpy(&result, &db, sizeof(result));
    return result;
}

// ── Wrappers arithmétiques ──────────────────────────────────────────────────
double __wrap___adddf3(double a, double b) { return _f2d(_d2f(a) + _d2f(b)); }
double __wrap___subdf3(double a, double b) { return _f2d(_d2f(a) - _d2f(b)); }
double __wrap___muldf3(double a, double b) { return _f2d(_d2f(a) * _d2f(b)); }
double __wrap___divdf3(double a, double b) { return _f2d(_d2f(a) / _d2f(b)); }

// ── Wrappers comparaison ────────────────────────────────────────────────────
int __wrap___ltdf2(double a, double b) { return _d2f(a) <  _d2f(b) ? -1 : 0; }
int __wrap___ledf2(double a, double b) { return _d2f(a) <= _d2f(b) ? -1 : 0; }
int __wrap___gtdf2(double a, double b) { return _d2f(a) >  _d2f(b) ?  1 : 0; }
int __wrap___gedf2(double a, double b) { return _d2f(a) >= _d2f(b) ?  1 : 0; }
int __wrap___eqdf2(double a, double b) { return _d2f(a) == _d2f(b) ?  0 : 1; }
int __wrap___nedf2(double a, double b) { return _d2f(a) != _d2f(b) ?  1 : 0; }

// ── Wrappers conversion ─────────────────────────────────────────────────────
double __wrap___floatsidf(int a)            { return _f2d((float)a); }
double __wrap___floatunsidf(unsigned int a) { return _f2d((float)a); }
double __wrap___floatdidf(long long a)      { return _f2d((float)a); }
int    __wrap___fixdfsi(double a)           { return (int)_d2f(a); }
long long __wrap___fixdfdi(double a)        { return (long long)_d2f(a); }
double __wrap___extendsfdf2(float a)        { return _f2d(a); }
float  __wrap___truncdfsf2(double a)        { return _d2f(a); }
