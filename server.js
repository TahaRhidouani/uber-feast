const fs = require("fs");
const ejs = require("ejs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const mongo = require("mongodb");
const bcrypt = require("bcrypt");
const app = express();
const MongoDBStore = require("connect-mongodb-session")(session);

const mongoURL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/";
const PORT = process.env.PORT || 8080;
const BCRYPT_HASH = /^\$2[aby]\$/;

let db;
let MongoClient = mongo.MongoClient;
let mongoStore = new MongoDBStore({
  uri: mongoURL,
  databaseName: "a4",
  collection: "sessiondata",
});

// The store has no touch(), which resave: false relies on to keep a used session from expiring
mongoStore.touch = function (id, session, callback) {
  const expires = session.cookie && session.cookie.expires ? new Date(session.cookie.expires) : new Date(Date.now() + this.options.expires);
  if (!this.db) return callback();
  this.db.collection(this.options.collection).updateOne(this._generateQuery(id), { $set: { [this.options.expiresKey]: expires } }, (error) => callback(error));
};

let restaurants = []; // The array that contains a list of all the restaurant objects

// For every file in the restaurants directory, add the information to the restaurant array and increment the id
fs.readdirSync("restaurants").forEach((file) => {
  let resto = JSON.parse(fs.readFileSync("restaurants/" + file));

  restaurants.push(resto);
});

app.set("trust proxy", true);
app.set("view-engine", "ejs");

app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.redirect("home/"));

app.use(express.static(path.join(__dirname, "views")));
app.use(express.json());
app.use((req, res, next) => (db ? next() : res.status(503).send()));
app.use(session({ secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"), resave: false, saveUninitialized: false, store: mongoStore, cookie: { secure: "auto", sameSite: "lax" } }));
app.use(express.urlencoded({ extended: true }));

app.get("*", auth); // For all get requests, check authentication status

app.get("/home", (req, res) => {
  // Serve the home page
  if (req.loggedIn) {
    res.render("home.ejs", { user: req.user });
  } else {
    res.render("home.ejs", { user: false });
  }
});

app.get("/order", (req, res) => {
  // Serve the login page if not logged in
  if (req.loggedIn) {
    res.render("orderMenu.ejs", { user: req.user });
  } else {
    res.redirect("../login/");
  }
});

app.get("/login", (req, res) => {
  // Serve the homepage if already logged in
  if (req.loggedIn) {
    res.redirect("../home/");
  } else {
    res.render("login.ejs");
  }
});

app.post("/login", (req, res) => {
  if (!validCredentialInput(req.body)) return res.status(400).send("Invalid credentials.");

  // Find the user and check the password against its hash
  db.collection("users").findOne({ username: req.body.username }, async function (err, result) {
    if (err) return res.status(400).send("An error occurred. Please try again."); // If an error occurs, send a error message back to the client

    // If the password matches, start a new session for the user and send back the user ID
    if (result && (await passwordMatches(req.body.password, result.password))) {
      signIn(req, result._id.toString(), (err) => (err ? res.status(400).send("An error occurred. Please try again.") : res.status(200).send(result._id.toString())));
    } else {
      // Otherwise, send a error message
      res.status(400).send("Invalid credentials.");
    }
  });
});

app.get("/register", (req, res) => {
  // Serve the homepage if already logged in
  if (req.loggedIn) {
    res.redirect("../home/");
  } else {
    res.render("register.ejs");
  }
});

app.post("/register", (req, res) => {
  if (!validCredentialInput(req.body)) return res.status(400).send("Invalid credentials.");

  // Check if a user already exists with the given username
  db.collection("users").findOne({ username: req.body.username }, async function (err, result) {
    if (result) return res.status(400).send("Username already taken, please try again.");

    // If not, add user to database with a hashed password, start a new session for the user and send back the user ID
    const password = await bcrypt.hash(req.body.password, 10);
    db.collection("users").insertOne({ username: req.body.username, password, privacy: false }, function (err, result) {
      if (err) return res.status(400).send("An error occurred. Please try again.");

      signIn(req, result.insertedId.toString(), (err) => (err ? res.status(400).send("An error occurred. Please try again.") : res.status(200).send(result.insertedId.toString())));
    });
  });
});

app.get("/logout", (req, res) => {
  // End the session, drop its cookie and redirect to home page, so the old session ID no longer works
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("../home/");
  });
});

app.get("/restaurants", (req, res) => {
  // If logged in, send the restaurants array data, otherwise, send back error message
  if (req.loggedIn) {
    res.status(200).send(restaurants);
  } else {
    res.status(403).send("You are not logged in.");
  }
});

app.get("/users", (req, res) => {
  let query = String(req.query.name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // Check given query, if null, set to empty string, and match it literally

  // Find all the matching users
  db.collection("users")
    .find({ privacy: false, username: { $regex: query, $options: "i" } }) // Using regex to find the query, with option "i" to make the search case-insensitive
    .toArray(function (err, result) {
      if (req.loggedIn) {
        res.render("users.ejs", { users: result, user: req.user });
      } else {
        res.render("users.ejs", { users: result, user: null });
      }
    });
});

app.post("/togglePrivacy", auth, (req, res) => {
  if (!req.loggedIn) return res.status(403).send(); // If not logged in, send back error message

  // Update the matching user's privacy settings
  db.collection("users").updateOne({ _id: req.user._id }, { $set: { privacy: !req.user.privacy } }, function (err, result) {
    if (err) return res.status(404).send(); // If an error occurred, send back error message

    res.status(200).send(!req.user.privacy); // If successful, send back the new user's privacy value as boolean
  });
});

app.get("/users/:id", (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return res.status(404).send("Invalid user.");

  // Find a user with the matching ID
  db.collection("users").findOne({ _id: mongo.ObjectId(req.params.id) }, function (err, result) {
    if (err) return res.status(400).send("An error occurred. Please try again."); // If an error occurred, send back error message

    if (result) {
      // If found a user with the matching ID, search all the orders with a buyer ID that matches the user's ID
      db.collection("orders")
        .find({ "buyer.username": result.username })
        .toArray(function (err, orders) {
          if (req.loggedIn) {
            if (req.user._id.toString() == result._id.toString()) {
              // If logged in, and the user's ID matches the viewed user's ID, send back user page with admin permissions to edit permissions
              res.render("user.ejs", { user: req.user, displayUser: result, admin: true, orders: orders });
            } else {
              // If logged in, but the user's ID doesn't matches the viewed user's ID, send back user page without admin permissions to edit permissions
              res.render("user.ejs", { user: req.user, displayUser: result, admin: false, orders: orders });
            }
          } else if (!result.privacy) {
            // If user is not logged in but the viewed user's profil is set to public
            res.render("user.ejs", { user: null, displayUser: result, admin: false, orders: orders });
          } else {
            // If user is not logged in and the viewed user's privacy is set to 'private', send back error message
            res.status(403).send("Forbidden access.");
          }
        });
    } else {
      res.status(404).send("Invalid user.");
    }
  });
});

app.post("/orders", auth, (req, res) => {
  if (!req.loggedIn) return res.status(403).send("You are not logged in.");

  // Insert a new order in the database with given information
  db.collection("orders").insertOne({ buyer: { id: req.user._id.toString(), username: req.user.username }, restaurantID: req.body.restaurantID, restaurantName: req.body.restaurantName, subtotal: req.body.subtotal, total: req.body.total, deliveryFee: req.body.deliveryFee, tax: req.body.tax, order: req.body.order }, function (err, result) {
    if (err) return res.status(400).send("An error occurred. Please try again."); // If an error occurs, send back error message

    res.status(200).send(result.insertedId.toString()); //If successful, send back order ID
  });
});

app.get("/orders/:id", (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return res.status(404).send("Invalid order.");

  // Find an order with the matching ID
  db.collection("orders").findOne({ _id: mongo.ObjectId(req.params.id) }, function (err, result) {
    if (err) return res.status(400).send("An error occurred. Please try again."); // If an error occurs, send back error message

    // If found an order
    if (result) {
      // If user is logged in and their ID matches the buyer's ID, show the order details regardless of privacy settings
      if (req.loggedIn && req.user._id.toString() == result.buyer.id) {
        res.render("order.ejs", { user: req.user, order: result });
      } else {
        // Otherwise, find the buyer's privacy settings and display the order details only if the user's profil is set to public
        db.collection("users").findOne({ _id: mongo.ObjectId(result.buyer.id) }, function (err, user) {
          if (err) return res.status(400).send("An error occurred. Please try again."); // If an error occurs, send back error message

          if (user) {
            if (!user.privacy) {
              res.render("order.ejs", { user: null, order: result });
            } else {
              res.status(403).send("Forbidden access.");
            }
          } else {
            res.status(404).send("Invalid order.");
          }
        });
      }
    } else {
      res.status(404).send("Invalid order.");
    }
  });
});

// Function that happens for all requests that require to check authentication
function auth(req, res, next) {
  // Set login values to false
  req.loggedIn = false;
  req.user = null;

  if (!req.session.userId) return next(); // If not signed in, continue to next middleware

  // Load the signed-in user; if it no longer exists, clear the session and continue logged out
  db.collection("users").findOne({ _id: new mongo.ObjectId(req.session.userId) }, function (err, result) {
    if (result) {
      req.loggedIn = true;
      req.user = result;
    } else if (!err) {
      req.session.userId = null;
    }
    next();
  });
}

// Give the signed-in user a new session ID (against session fixation) that holds only the user ID
function signIn(req, userId, callback) {
  req.session.regenerate((err) => {
    if (err) return callback(err);
    req.session.userId = userId;
    req.session.save(callback);
  });
}

// Usernames and passwords must be text, and bcrypt only uses the first 72 bytes of a password
function validCredentialInput(body) {
  return typeof body.username === "string" && typeof body.password === "string" && Buffer.byteLength(body.password) <= 72;
}

// Compare a password with a stored bcrypt hash
function passwordMatches(password, hash) {
  return typeof hash === "string" && BCRYPT_HASH.test(hash) ? bcrypt.compare(password, hash) : Promise.resolve(false);
}

// Hash any password still stored in plain text and delete sessions from before, which hold a password.
// Runs on every start and does nothing once none are left.
async function migratePasswords(database) {
  const users = await database.collection("users").find({ password: { $type: "string", $not: BCRYPT_HASH } }, { projection: { password: 1 } }).toArray();
  for (const user of users) {
    await database.collection("users").updateOne({ _id: user._id, password: user.password }, { $set: { password: await bcrypt.hash(user.password, 10) } });
  }

  const sessions = await database.collection("sessiondata").deleteMany({ "session.password": { $exists: true } });
  if (users.length || sessions.deletedCount) console.log(`Hashed ${users.length} stored passwords, deleted ${sessions.deletedCount} sessions that held one`);
}

app.listen(PORT, () => console.log("Server running at http://localhost:" + PORT));

// Connect to the database and hash leftover plain-text passwords before serving requests, exit if it is unreachable
MongoClient.connect(mongoURL, async function (err, client) {
  if (err) throw err;

  const database = client.db("a4");
  await migratePasswords(database);
  db = database;
});
