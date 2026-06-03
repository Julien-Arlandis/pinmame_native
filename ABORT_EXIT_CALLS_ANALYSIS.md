# PinMAME Source Code - Abort/Exit Calls Analysis

## Summary
The pinmame source code contains **NO direct calls to `abort()` or `emscripten_abort()`**. However, there are numerous **`exit()` calls** throughout the codebase, primarily triggered by memory allocation failures and error conditions. These need to be handled carefully, especially for WebAssembly/Emscripten builds.

---

## Critical Memory-Related Exit Calls

### 1. **windows/winalloc.c - Line 82** ⚠️ CRITICAL
**File:** [src/windows/winalloc.c](src/windows/winalloc.c#L82)

```c
INLINE memory_entry *allocate_entry(void)
{
    int i;
    
    // find an empty entry
    for (i = 0; i < MAX_ALLOCS; i++)
        if (memory_list[i].vbase == NULL)
            return &memory_list[i];
    
    // if none, error out in a fatal way
    fprintf(stderr, "Out of allocation blocks!\n");
    exit(1);
}
```
**Trigger:** When more than 65,536 (MAX_ALLOCS) memory allocation entries are attempted.
**Context:** This is a Windows-specific memory allocator wrapper. Exhaustion of allocation slots.

---

### 2. **libpinmame/fileio.c - Lines 335 & 404** ⚠️ MEMORY ERROR
**File:** [src/libpinmame/fileio.c](src/libpinmame/fileio.c#L335)

**Line 335:**
```c
out_of_memory:
    fprintf(stderr, "Out of memory in variable expansion!\n");
    exit(1);
```
**Trigger:** Memory allocation failure during path variable expansion in fileio operations.

**Line 404:**
```c
    // when finished, reset the path info, so that future INI parsing will
    // cause us to get called again
    return;

out_of_memory:
    fprintf(stderr, "Out of memory!\n");
    exit(1);
```
**Trigger:** Memory allocation failure during pathlist expansion. The realloc() call can fail and trigger this exit.

---

### 3. **config.c - Line 683** 
**File:** [src/config.c](src/config.c#L683)

```c
                exit(1);
```
**Context:** Configuration file parsing error handling. Specific trigger condition requires more context from surrounding code.

---

### 4. **cpu/adsp2100/adsp2100.c - Line 563** ⚠️ TABLE CREATION FAILURE
**File:** [src/cpu/adsp2100/adsp2100.c](src/cpu/adsp2100/adsp2100.c#L563)

```c
void adsp2100_init(void *param)
{
    /* create the tables */
    if (!create_tables())
        exit(-1);
}
```
**Trigger:** Failure to create CPU instruction tables during initialization.
**Context:** Critical CPU initialization failure.

---

### 5. **state.c - Line 305** ⚠️ SAVE STATE ERROR
**File:** [src/state.c](src/state.c#L305)

```c
void save_state_function(...)
{
    while (next)
    {
        if (next->func == func && next->tag == ss_current_tag)
        {
            logerror("Duplicate save state function (%d, 0x%x)\n", ss_current_tag, (size_t)func);
            exit(1);
        }
        next = next->next;
    }
    next = *root;
    *root = malloc(sizeof(ss_func));
```
**Trigger:** Duplicate save state function registration or malloc failure.

---

### 6. **cheat.c - Line 2032** 
**File:** [src/cheat.c](src/cheat.c#L2032)

```c
                        (size_t)menuStrings.buf);

        exit(1);
    }

    traverse = menuStrings.buf;
```
**Trigger:** Cheat menu string allocation failure.

---

## Memory Allocation Patterns (Potential Silent Failures)

### auto_malloc() Function
**File:** [src/common.c](src/common.c#L665)

```c
void *auto_malloc(size_t size)
{
    void *result = malloc(size);
    if (result)
    {
        struct malloc_info *info;
        
        /* make sure we have space */
        if (malloc_list_index >= MAX_MALLOCS)
        {
            fprintf(stderr, "Out of malloc tracking slots!\n");
            return result;  // Returns result even though tracking failed!
        }
        
        /* fill in the current entry */
        info = &malloc_list[malloc_list_index++];
        info->tag = get_resource_tag();
        info->ptr = result;
    }
    return result;  // Can return NULL on malloc failure
}
```

**Issues:**
- Returns NULL on malloc failure (no exit call, but callers must check)
- If tracking slots are exhausted, returns result but doesn't track it
- Callers like [mame.c lines 997-1008](src/mame.c#L997) DO check for NULL and return error codes

---

### Memory Region Allocation
**File:** [src/common.c](src/common.c#L378)

```c
if (num < MAX_MEMORY_REGIONS)
{
    Machine->memory_region[num].length = length;
    Machine->memory_region[num].base = malloc(length);
    return (Machine->memory_region[num].base == NULL) ? 1 : 0;
}
```

**Pattern:** Returns error code (1) on malloc failure instead of exiting - this is safer.

---

## File I/O Related Exit Calls

**files:**
- [src/windows/fileio.c](src/windows/fileio.c#L269) - Line 269
- [src/windows/fileio.c](src/windows/fileio.c#L338) - Line 338
- [src/libpinmame/fileio.c](src/libpinmame/fileio.c#L335) - Line 335, 404

**Context:** File operations and path handling errors

---

## Configuration & Window Management Exit Calls

**Multiple exit(1) calls in:**
- [src/windows/config.c](src/windows/config.c) - Lines 446, 453, 461, 470, 475, 479, 486, 493, 502, 515, 548, 591, 615, 622, 631, 815
- [src/windows/window.c](src/windows/window.c) - Lines 1718, 1723, 1811
- [src/windows/input.c](src/windows/input.c) - Lines 1810, 1844, 1850

**Context:** Windows-specific UI initialization and input handling failures.

---

## CPU Initialization Exit Calls

Various CPU implementations call **`exit()` functions** (not directly exiting, but cleanup):
- `cpu_exit()` - general CPU cleanup
- `z80_exit()` - Z80 CPU cleanup
- `adsp2100_exit()` - ADSP2100 cleanup
- `m6809_exit()` - M6809 cleanup
- `i8085_exit()` / `i8080_exit()` - Intel CPU cleanup
- `s2650_exit()` - S2650 cleanup
- `tms7000_exit()` / `tms9900_exit()` - TMS CPU cleanup
- `at91_exit()` - ARM CPU cleanup
- `i8051_exit()` / `i8752_exit()` - 8051 CPU cleanup

**Note:** These are `_exit()` function calls (cleanup functions), NOT direct program exits.

---

## Sound System Exit Calls

Multiple malloc failures in sound subsystem:
- [src/sound/discrete.c](src/sound/discrete.c) - Lines 353, 364
- [src/sound/fm.c](src/sound/fm.c) - Lines 2295, 3591, 4352, 4878, 5558
- [src/sound/disc_*.c](src/sound/) - Multiple files with malloc checks

**Pattern:** All use NULL checks and return error codes; no direct exit() calls.

---

## Utility Programs Exit Calls

**xml2info tool:**
- [src/xml2info/xml2info.c](src/xml2info/xml2info.c) - Lines 811, 815, 820
  - `exit(EXIT_SUCCESS)` for normal completion
  - `exit(EXIT_FAILURE)` for error handling

**Context:** This is a utility program, not the core emulator.

---

## Key Findings for Emscripten/WASM

### 🔴 **CRITICAL ISSUES:**

1. **No direct abort() or emscripten_abort() calls found**
   - All exits use standard `exit()` function
   - Emscripten will convert these to `emscripten_force_exit()`

2. **Direct exit() calls that cannot be recovered:**
   - `winalloc.c:82` - Memory allocation slot exhaustion
   - `adsp2100.c:563` - CPU table creation failure
   - `fileio.c:335,404` - Path expansion failures
   - `cheat.c:2032` - Cheat system failures
   - `state.c:305` - Save state failures

3. **Memory-safe patterns (that DON'T exit):**
   - `auto_malloc()` returns NULL on failure
   - Memory region allocation returns error codes
   - Sound system checks allocations
   - Video system checks bitmap allocations

---

## Recommendations

### For WebAssembly/Emscripten:

1. **Replace exit() calls with error callbacks** in memory allocation critical sections:
   ```c
   // Instead of exit(1) in winalloc.c:
   // Call an error handler that can be caught in JavaScript
   ```

2. **Add graceful degradation:**
   - Catch malloc failures before they trigger exit()
   - Implement error callbacks instead of process termination

3. **Prioritize handling these files:**
   - `src/windows/winalloc.c` - Memory management
   - `src/libpinmame/fileio.c` - File path expansion
   - `src/cpu/adsp2100/adsp2100.c` - CPU initialization
   - `src/state.c` - Save state handling

4. **Review WASM build options:**
   - Check if Emscripten's `--shell-file` or error handling is configured
   - Consider using `emscripten_force_exit()` wrapper functions
   - Implement longjmp/setjmp for error recovery where possible

---

## Files Analyzed

- `/src/common.c` - Memory allocation tracking
- `/src/mame.c` - Main initialization
- `/src/state.c` - Save state system
- `/src/config.c` - Configuration
- `/src/cheat.c` - Cheat system
- `/src/libpinmame/fileio.c` - File I/O
- `/src/libpinmame/libpinmame.cpp` - Library interface
- `/src/windows/winalloc.c` - Windows memory allocator
- `/src/windows/fileio.c` - Windows file I/O
- `/src/windows/config.c` - Windows configuration
- `/src/windows/window.c` - Windows window management
- `/src/cpu/adsp2100/adsp2100.c` - ADSP2100 CPU init
- And 100+ CPU, sound, and utility files

