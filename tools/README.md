# Tools

These are tools used by devs working on the compiler. Some are just novelties, like the vizworld, but some tools start out here before becoming their own module or repo.

These may or may not be kept up to date with the language as it is being worked on. Do not report bugs or issues with these tools. PRs to update them to the current language state, if outdated, are okay. There are often breaking changes in this early part of the language.

Tools will be moved into the archive folder or deleted as needed.

## Source Code Only

This is not a dist or build location for tools, this is just the yoop (or other lanugage) source code for the tool. These are meant to be compiled on the dev machine and used as-needed there. The common .gitignore should keep binaries and exe's out.

## Limit assets and large codebases

Do not add tools that have a lot of assets or very large sources. The vizworld is way too large, but it is the example of a "powerful" plugin. And so will stay with the compiler repo. Larger tools are probably useful, but should just be moved into their own repository.

## Use folders

Place the tool in a folder, at least. I don't care if it is just one large main.yoop file beyond that.

## List compiler version and platform

It'd be nice to know which version of the compiler and platform you were on when writing the tool or using it and confirmed it works still. If you make code changes at all, and unless you know better, just set the compiler version notes to only this platform and version. If you don't make codechanges and just build it and it works, you can extend the compiler version range.

### Example

add a verified: platform & version range

```yoop
/*
    vizworld - compiler visualizer tool

    verified: linux-x64 v0.2.1 - v0.3.0
*/

```
