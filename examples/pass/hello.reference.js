// equivalent javascript for test.yoop

function printf(str) {
  console.log(str);
}

function pow(a, b) {
  let i = 0;
  let r = 1;
  while (i < b) {
    i = i + 1;
    r = r * a;
  }

  return r;
}

function main() {
  printf("Hello, World!");
  let x = 4 + 5;
  printf(`x is ${x}`);
  printf(`sum: ${x + 1}, doubled: ${x * 2}`);
  let y = pow(3, 5); // should be 243?
  printf(`pow: 3 to the 5th is ${y}`);
  return 0;
}

main();
