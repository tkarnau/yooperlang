// Windows-only OpenGL entry-point shim.
//
// Why this file exists at all: on macOS and Linux the modern OpenGL entry
// points are ordinary exported symbols, so `extern "C" from library
// "framework:OpenGL"` links against them directly and there is nothing to do.
// Windows is different in a way that no linker flag can paper over -
// opengl32.dll exports OpenGL 1.1 and nothing newer. Every shader, VAO, VBO
// and uniform call (GL 1.5 / 2.0 / 3.x) has to be looked up at run time
// against the *current context* via wglGetProcAddress, because the entry
// point belongs to the installed display driver rather than to the OS.
//
// That is why C libraries like GLEW and glad exist. We cannot link one of
// those, though: they resolve into pointers named `__glewCreateShader` /
// `glad_glCreateShader` and expose the plain `glCreateShader` spelling only
// as a preprocessor macro. A macro is invisible to the yoop compiler, which
// emits a call to the literal symbol name written in the extern block. So we
// need real functions with the real names, and that is what this file is:
// one forwarding stub per entry point, each resolving its target on first
// call and caching it.
//
// This is NOT part of RUNTIME_SOURCES. It is compiled in only when a program
// actually asks for OpenGL - see glueSourcesForLinkFlags() in
// src/toolchain.js - so ordinary programs carry none of it.
//
// Scope: the GL >= 1.2 entry points. The 1.1 surface (glClear, glViewport,
// glEnable, glBlendFunc, glDrawArrays, the fixed-function texture calls, ...)
// is deliberately absent because opengl32.lib already resolves it; adding
// stubs here would be a duplicate-symbol error. Anything missing from the
// table below surfaces as an ordinary "unresolved external symbol glFoo" at
// link time, and the fix is to add one line.
//
// Calling convention note (x64): the real GL functions are APIENTRY, i.e.
// __stdcall, and the loaded function POINTERS are typed that way because that
// is the ABI the driver exports. The stubs themselves are declared with the
// default convention, which is what yoop codegen emits at the call site. On
// x86_64 those two are the same convention so the adaptation is free. A 32-bit
// Windows target would need the stubs marked APIENTRY as well; the compiler
// targets x86_64-pc-windows-msvc, so that case does not arise today.

#ifdef _WIN32

#include "yoop_platform.h"

#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

// Minimal GL scalar typedefs. Deliberately not `#include <GL/gl.h>`: the
// Windows SDK copy is a 1.1-era header that lacks GLchar / GLsizeiptr
// entirely, and pulling it in would also redeclare the 1.1 functions we are
// pointedly NOT defining here.
typedef unsigned int GLenum;
typedef unsigned int GLbitfield;
typedef unsigned int GLuint;
typedef int GLint;
typedef int GLsizei;
typedef unsigned char GLboolean;
typedef float GLfloat;
typedef char GLchar;
typedef ptrdiff_t GLsizeiptr;
typedef ptrdiff_t GLintptr;

typedef PROC(WINAPI *wgl_get_proc_address_t)(LPCSTR);

static HMODULE yoop_gl_dll;
static wgl_get_proc_address_t yoop_wgl_get_proc_address;

// Resolve one entry point by name, or die with a message that says which one.
//
// Two sources, in order:
//   1. wglGetProcAddress - the driver's own export table. This is where every
//      post-1.1 entry point lives, and it only works once a GL context is
//      current on the calling thread (hence lazy, per-call-site resolution
//      rather than an init hook: by the time a stub is first called the
//      program has necessarily created its context).
//   2. GetProcAddress on opengl32.dll - the documented fallback. Some drivers
//      return NULL from wglGetProcAddress for entry points they happen to
//      serve out of the DLL itself.
//
// wglGetProcAddress signals failure with NULL on some drivers and with 1, 2,
// 3 or -1 on others (a long-standing wart, which is why every loader library
// carries this same check).
static void *yoop_gl_proc(const char *name) {
    if (yoop_gl_dll == NULL) {
        yoop_gl_dll = LoadLibraryA("opengl32.dll");
        if (yoop_gl_dll != NULL) {
            yoop_wgl_get_proc_address =
                (wgl_get_proc_address_t)(void *)GetProcAddress(yoop_gl_dll, "wglGetProcAddress");
        }
    }

    void *p = NULL;
    if (yoop_wgl_get_proc_address != NULL) {
        p = (void *)yoop_wgl_get_proc_address(name);
        if (p == (void *)1 || p == (void *)2 || p == (void *)3 || p == (void *)-1) p = NULL;
    }
    if (p == NULL && yoop_gl_dll != NULL) {
        p = (void *)GetProcAddress(yoop_gl_dll, name);
    }
    if (p == NULL) {
        fprintf(stderr,
                "yoop: OpenGL entry point \"%s\" is unavailable.\n"
                "  Either no GL context was current when it was first called, or the\n"
                "  installed display driver does not implement it.\n",
                name);
        fflush(stderr);
        abort();
    }
    return p;
}

// One stub per entry point. `params` and `args` are parenthesized so their
// internal commas survive macro expansion.
//
// The cached pointer is written without synchronization. Two threads racing
// on first call both resolve the same address and store the same value, so
// the race is benign - and GL itself is single-context-per-thread, which
// makes concurrent first calls to the same entry point unlikely anyway.
#define GL_STUB_VOID(name, params, args)                            \
    typedef void(APIENTRY *yoopgl_##name##_t) params;               \
    static yoopgl_##name##_t yoopgl_##name;                         \
    void name params {                                              \
        if (yoopgl_##name == NULL)                                  \
            yoopgl_##name = (yoopgl_##name##_t)yoop_gl_proc(#name); \
        yoopgl_##name args;                                         \
    }

#define GL_STUB(ret, name, params, args)                            \
    typedef ret(APIENTRY *yoopgl_##name##_t) params;                \
    static yoopgl_##name##_t yoopgl_##name;                         \
    ret name params {                                               \
        if (yoopgl_##name == NULL)                                  \
            yoopgl_##name = (yoopgl_##name##_t)yoop_gl_proc(#name); \
        return yoopgl_##name args;                                  \
    }

// ---- shaders and programs (GL 2.0) ----------------------------------------

GL_STUB(GLuint, glCreateShader, (GLenum stage), (stage))
GL_STUB_VOID(glShaderSource,
             (GLuint sh, GLsizei count, const GLchar *const *strings, const GLint *lengths),
             (sh, count, strings, lengths))
GL_STUB_VOID(glCompileShader, (GLuint sh), (sh))
GL_STUB_VOID(glGetShaderiv, (GLuint sh, GLenum pname, GLint *params), (sh, pname, params))
GL_STUB_VOID(glGetShaderInfoLog,
             (GLuint sh, GLsizei max_len, GLsizei *length, GLchar *log),
             (sh, max_len, length, log))
GL_STUB_VOID(glDeleteShader, (GLuint sh), (sh))
GL_STUB_VOID(glDetachShader, (GLuint prog, GLuint sh), (prog, sh))

GL_STUB(GLuint, glCreateProgram, (void), ())
GL_STUB_VOID(glAttachShader, (GLuint prog, GLuint sh), (prog, sh))
GL_STUB_VOID(glLinkProgram, (GLuint prog), (prog))
GL_STUB_VOID(glGetProgramiv, (GLuint prog, GLenum pname, GLint *params), (prog, pname, params))
GL_STUB_VOID(glGetProgramInfoLog,
             (GLuint prog, GLsizei max_len, GLsizei *length, GLchar *log),
             (prog, max_len, length, log))
GL_STUB_VOID(glUseProgram, (GLuint prog), (prog))
GL_STUB_VOID(glDeleteProgram, (GLuint prog), (prog))
GL_STUB_VOID(glBindAttribLocation,
             (GLuint prog, GLuint index, const GLchar *name),
             (prog, index, name))
GL_STUB(GLint, glGetAttribLocation, (GLuint prog, const GLchar *name), (prog, name))
// GL 3.0 - the fragment-output binding the core profile wants.
GL_STUB_VOID(glBindFragDataLocation,
             (GLuint prog, GLuint color_number, const GLchar *name),
             (prog, color_number, name))

// ---- uniforms (GL 2.0) ----------------------------------------------------

GL_STUB(GLint, glGetUniformLocation, (GLuint prog, const GLchar *name), (prog, name))
GL_STUB_VOID(glUniform1i, (GLint loc, GLint v0), (loc, v0))
GL_STUB_VOID(glUniform1f, (GLint loc, GLfloat v0), (loc, v0))
GL_STUB_VOID(glUniform2f, (GLint loc, GLfloat v0, GLfloat v1), (loc, v0, v1))
GL_STUB_VOID(glUniform3f, (GLint loc, GLfloat v0, GLfloat v1, GLfloat v2), (loc, v0, v1, v2))
GL_STUB_VOID(glUniform4f,
             (GLint loc, GLfloat v0, GLfloat v1, GLfloat v2, GLfloat v3),
             (loc, v0, v1, v2, v3))
GL_STUB_VOID(glUniform1fv, (GLint loc, GLsizei count, const GLfloat *v), (loc, count, v))
GL_STUB_VOID(glUniform2fv, (GLint loc, GLsizei count, const GLfloat *v), (loc, count, v))
GL_STUB_VOID(glUniform3fv, (GLint loc, GLsizei count, const GLfloat *v), (loc, count, v))
GL_STUB_VOID(glUniform4fv, (GLint loc, GLsizei count, const GLfloat *v), (loc, count, v))
GL_STUB_VOID(glUniformMatrix3fv,
             (GLint loc, GLsizei count, GLboolean transpose, const GLfloat *v),
             (loc, count, transpose, v))
GL_STUB_VOID(glUniformMatrix4fv,
             (GLint loc, GLsizei count, GLboolean transpose, const GLfloat *v),
             (loc, count, transpose, v))

// ---- buffers (GL 1.5) and vertex arrays (GL 3.0) --------------------------

GL_STUB_VOID(glGenBuffers, (GLsizei n, GLuint *buffers), (n, buffers))
GL_STUB_VOID(glBindBuffer, (GLenum target, GLuint buffer), (target, buffer))
GL_STUB_VOID(glBufferData,
             (GLenum target, GLsizeiptr size, const void *data, GLenum usage),
             (target, size, data, usage))
GL_STUB_VOID(glBufferSubData,
             (GLenum target, GLintptr offset, GLsizeiptr size, const void *data),
             (target, offset, size, data))
GL_STUB_VOID(glDeleteBuffers, (GLsizei n, const GLuint *buffers), (n, buffers))

GL_STUB_VOID(glGenVertexArrays, (GLsizei n, GLuint *arrays), (n, arrays))
GL_STUB_VOID(glBindVertexArray, (GLuint array), (array))
GL_STUB_VOID(glDeleteVertexArrays, (GLsizei n, const GLuint *arrays), (n, arrays))

GL_STUB_VOID(glVertexAttribPointer,
             (GLuint index,
              GLint size,
              GLenum type,
              GLboolean normalized,
              GLsizei stride,
              const void *offset),
             (index, size, type, normalized, stride, offset))
GL_STUB_VOID(glEnableVertexAttribArray, (GLuint index), (index))
GL_STUB_VOID(glDisableVertexAttribArray, (GLuint index), (index))
GL_STUB_VOID(glVertexAttribDivisor, (GLuint index, GLuint divisor), (index, divisor))

// ---- assorted post-1.1 state and draw calls -------------------------------

GL_STUB_VOID(glActiveTexture, (GLenum texture), (texture))
GL_STUB_VOID(glGenerateMipmap, (GLenum target), (target))
GL_STUB_VOID(glBlendEquation, (GLenum mode), (mode))
GL_STUB_VOID(glBlendFuncSeparate,
             (GLenum src_rgb, GLenum dst_rgb, GLenum src_alpha, GLenum dst_alpha),
             (src_rgb, dst_rgb, src_alpha, dst_alpha))
GL_STUB_VOID(glDrawArraysInstanced,
             (GLenum mode, GLint first, GLsizei count, GLsizei instances),
             (mode, first, count, instances))
GL_STUB_VOID(glDrawElementsInstanced,
             (GLenum mode, GLsizei count, GLenum type, const void *indices, GLsizei instances),
             (mode, count, type, indices, instances))

// ---- framebuffer objects (GL 3.0) -----------------------------------------

GL_STUB_VOID(glGenFramebuffers, (GLsizei n, GLuint *fbs), (n, fbs))
GL_STUB_VOID(glBindFramebuffer, (GLenum target, GLuint fb), (target, fb))
GL_STUB_VOID(glDeleteFramebuffers, (GLsizei n, const GLuint *fbs), (n, fbs))
GL_STUB_VOID(glFramebufferTexture2D,
             (GLenum target, GLenum attachment, GLenum textarget, GLuint texture, GLint level),
             (target, attachment, textarget, texture, level))
GL_STUB(GLenum, glCheckFramebufferStatus, (GLenum target), (target))
GL_STUB_VOID(glGenRenderbuffers, (GLsizei n, GLuint *rbs), (n, rbs))
GL_STUB_VOID(glBindRenderbuffer, (GLenum target, GLuint rb), (target, rb))
GL_STUB_VOID(glDeleteRenderbuffers, (GLsizei n, const GLuint *rbs), (n, rbs))
GL_STUB_VOID(glRenderbufferStorage,
             (GLenum target, GLenum format, GLsizei w, GLsizei h),
             (target, format, w, h))
GL_STUB_VOID(glFramebufferRenderbuffer,
             (GLenum target, GLenum attachment, GLenum rbtarget, GLuint rb),
             (target, attachment, rbtarget, rb))

#else

// Keep the translation unit non-empty on non-Windows hosts. Nothing should be
// compiling this file there (the driver only adds it for win32), but an empty
// TU is a constraint violation in C and would fail a strict build.
typedef int yoop_gl_win32_unused;

#endif // _WIN32
