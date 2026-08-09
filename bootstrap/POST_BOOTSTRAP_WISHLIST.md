# Compiler Change Wishlist

We no longer want to make significant changes to the compiler while we're bootstrapping the language. However, while writing the bootstrap program, and it being a large program in the language. We want to capture any real pain points or real opportunities for improvements to implement after finishing the bootstrapping process.

## Changes

### Kind and trait import inferences

Better inference for kinds and traits without needing to import as often

### return on all paths analysis - DONE PRE BOOTSTRAP

~~Right now any function that has a return anywhere is a valid returning function, even if it is inside an if-statement and not a void function. Need to do some codepath analysis here.~~
