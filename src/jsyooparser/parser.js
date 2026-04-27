import { lexNext, TokenTags } from "../jsyooplexer/lexer.js";

export function parse(src) {
  let pos = 0;

  function next() {
    const res = lexNext(src, pos);
    pos = res.nextPos;

    // temp
    console.log("token", res.token.tag);
    // end temp

    return res.token.tag;
  }

  let result = null;
  do {
    result = next();
  } while (result != TokenTags.eof && result != TokenTags.discard)
}
