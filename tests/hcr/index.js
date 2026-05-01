const fs = require("fs");
const path = require("path");

let mymodule = require("./mymodule");
let counter = 0;
const history = [];

for (let i = 0; i < 12; i++) {
  counter++;
  if (counter === 7) {
    fs.copyFileSync(
      path.join(__dirname, "mymodule_v2.js"),
      path.join(__dirname, "mymodule.js"),
    );
    delete require.cache[require.resolve("./mymodule")];
    mymodule = require("./mymodule");
    console.log("RELOAD_APPLIED");
  }
  const value = mymodule.compute(counter);
  const delta = mymodule.transform(value, counter);
  history.push(delta);
  const total = mymodule.aggregate(history);
  console.log(`step=${counter} value=${value} delta=${delta} total=${total}`);
}
