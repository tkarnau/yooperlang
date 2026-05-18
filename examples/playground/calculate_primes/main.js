function getPrimesUpTo(n) {
  const primes = [];
  
  // Helper to check if a single number is prime
  const isPrime = num => {
    for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
        if (num % i === 0) return false; 
    }
    return num > 1;
  };

  for (let i = 2; i <= n; i++) {
    if (isPrime(i)) primes.push(i);
  }
  return primes;
}

console.log(getPrimesUpTo(10000));