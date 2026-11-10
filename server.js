const fs = require("fs");
const ejs = require("ejs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const mongo = require("mongodb");
const app = express();
const MongoDBStore = require("connect-mongodb-session")(session);

const mongoURL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/";
const PORT = process.env.PORT || 8080;

let db;
let MongoClient = mongo.MongoClient;
let mongoStore = new MongoDBStore({
  uri: mongoURL,
  databaseName: "a4",
  collection: "sessiondata",
});

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
app.use(session({ secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"), resave: true, saveUninitialized: true, store: mongoStore, cookie: { secure: "auto", sameSite: "lax" } }));
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
  if (typeof req.body.username !== "string" || typeof req.body.password !== "string") return res.status(400).send("Invalid credentials.");

  // Find a corresponding user with the given credentials
  db.collection("users").findOne({ username: req.body.username, password: req.body.password }, function (err, result) {
    if (err) return res.status(400).send("An error occurred. Please try again."); // If an error occurs, send a error message back to the client

    // If found a matching user, save credentials to cookies and send back the user ID
    if (result) {
      req.session.username = result.username;
      req.session.password = result.password;
      res.status(200).send(result._id.toString());
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
  if (typeof req.body.username !== "string" || typeof req.body.password !== "string") return res.status(400).send("Invalid credentials.");

  // Check if a user already exists with the given username
  db.collection("users").findOne({ username: req.body.username }, function (err, result) {
    if (result) return res.status(400).send("Username already taken, please try again.");

    // If not, add user to database, save credentials to cookies and send back the user ID
    db.collection("users").insertOne({ username: req.body.username, password: req.body.password, privacy: false }, function (err, result) {
      if (err) return res.status(400).send("An error occurred. Please try again.");

      req.session.username = result.username;
      req.session.password = result.password;
      res.status(200).send(result.insertedId.toString());
    });
  });
});

app.get("/logout", (req, res) => {
  // Set the credential cookies to null and redirect to home page
  req.session.username = null;
  req.session.password = null;
  res.redirect("../home/");
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
  db.collection("users").updateOne({ username: req.session.username, password: req.session.password }, { $set: { privacy: !req.user.privacy } }, function (err, result) {
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

  if (req.session.username == undefined || req.session.password == undefined) return next(); // If no cookies, continue to next middleware

  // If found a user with corresponding username and password, update login values and continue to next middleware
  db.collection("users").findOne({ username: req.session.username, password: req.session.password }, function (err, result) {
    if (result) {
      req.loggedIn = true;
      req.user = result;
      next();
    }
  });
}

app.listen(PORT, () => console.log("Server running at http://localhost:" + PORT));

// Connect to the database, exit if it is unreachable
MongoClient.connect(mongoURL, function (err, client) {
  if (err) throw err;

  db = client.db("a4");
});
