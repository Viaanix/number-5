// Prints the arguments this process received as one JSON array. The quoting tests
// run it through a real shell to see what the shell actually passes to a program.
console.log(JSON.stringify(process.argv.slice(2)));
