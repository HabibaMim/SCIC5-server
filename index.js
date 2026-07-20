const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const db = client.db("gigsversedb");
const gigCollection = db.collection("gigs");
const orderCollection = db.collection("orders");
const reviewCollection = db.collection("reviews");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ---------- Middleware ----------

const logger = (req, res, next) => {
  console.log(`${req.method} | ${req.url}`);
  next();
};

const verifyToken = async (req, res, next) => {
  const { authorization } = req.headers;
  const token = authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const JWKS = createRemoteJWKSet(
      new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
    );
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    console.error('Token validation failed:', error);
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

// ---------- Health ----------

app.get('/', (req, res) => {
  res.send('GigsVerse API is running!');
});

app.get('/health', async (req, res) => {
  try {
    await client.db("admin").command({ ping: 1 });
    res.json({ status: "ok", message: "MongoDB connected successfully" });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------- Gigs ----------

app.post('/gigs', verifyToken, async (req, res) => {
  const data = req.body;
  const result = await gigCollection.insertOne(data);
  res.send(result);
});

app.get("/gigs", async (req, res) => {
  const { search, category, minPrice, maxPrice, sortBy, page, limit } = req.query;
  let query = {};

  if (search) {
    query["Title"] = { $regex: search, $options: 'i' };
  }

  if (category) {
    query["Category"] = category;
  }

  if (minPrice || maxPrice) {
    const priceFilter = {};
    if (minPrice) priceFilter.$gte = Number(minPrice);
    if (maxPrice) priceFilter.$lte = Number(maxPrice);
    query["Starting Price"] = priceFilter;
  }

  let sortOption = {};
  if (sortBy === "priceLowHigh") sortOption = { "Starting Price": 1 };
  if (sortBy === "priceHighLow") sortOption = { "Starting Price": -1 };
  if (sortBy === "popular") sortOption = { orderCount: -1 };

  const pageNum = Number(page) || 1;
  const limitNum = Number(limit) || 8;
  const skip = (pageNum - 1) * limitNum;

  const totalCount = await gigCollection.countDocuments(query);
  const cursor = gigCollection.find(query).sort(sortOption).skip(skip).limit(limitNum);
  const result = await cursor.toArray();

  res.send({
    gigs: result,
    totalCount,
    totalPages: Math.ceil(totalCount / limitNum),
    currentPage: pageNum,
  });
});

app.get("/gigs/:gigId", logger, verifyToken, async (req, res) => {
  const { gigId } = req.params;
  const query = { _id: new ObjectId(gigId) };
  const result = await gigCollection.findOne(query);
  res.send(result);
});

app.get("/featured", async (req, res) => {
  const cursor = gigCollection.find().limit(4);
  const result = await cursor.toArray();
  res.send(result);
});

app.put("/gigs/:gigId", async (req, res) => {
  const { gigId } = req.params;
  const updatedData = req.body;
  const query = { _id: new ObjectId(gigId) };
  const update = { $set: updatedData };
  const result = await gigCollection.updateOne(query, update);
  res.send(result);
});

app.patch("/gigs/:gigId", verifyToken, async (req, res) => {
  const { gigId } = req.params;
  const updatedData = req.body;
  const filter = { _id: new ObjectId(gigId) };
  const updatedDoc = { $set: { ...updatedData } };
  const result = await gigCollection.updateOne(filter, updatedDoc);
  res.send(result);
});

app.delete("/gigs/:gigId", verifyToken, async (req, res) => {
  const { gigId } = req.params;
  const query = { _id: new ObjectId(gigId) };
  const result = await gigCollection.deleteOne(query);
  res.send(result);
});

app.get("/listings/:userId", verifyToken, async (req, res) => {
  const { userId } = req.params;
  const result = await gigCollection.find({ sellerId: userId }).toArray();
  res.send(result);
});

// ---------- Orders ----------

app.post("/orders/:gigId", verifyToken, async (req, res) => {
  const { gigId } = req.params;
  const orderData = req.body;

  const gig = await gigCollection.findOne({ _id: new ObjectId(gigId) });
  if (!gig) {
    return res.status(404).json({ message: 'Gig Not Found!' });
  }

  await gigCollection.updateOne({ _id: new ObjectId(gigId) }, {
    $inc: { orderCount: 1 },
    $set: { lastOrderedAt: new Date() }
  });

  const result = await orderCollection.insertOne({
    ...orderData,
    gigId: gig?._id,
    orderedAt: new Date(),
  });

  res.send(result);
});

app.get("/orders/:userId", verifyToken, async (req, res) => {
  const { userId } = req.params;
  const result = await orderCollection.find({ userId }).toArray();
  res.send(result);
});

app.delete('/orders/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const order = await orderCollection.findOne({ _id: new ObjectId(id) });
  const gigId = order?.gigId;
  const result = await orderCollection.deleteOne({ _id: new ObjectId(id) });

  await gigCollection.updateOne(
    { _id: gigId },
    { $inc: { orderCount: -1 } }
  );
  res.send(result);
});

// ---------- Reviews ----------

app.get("/reviews/:gigId", async (req, res) => {
  const { gigId } = req.params;
  const result = await reviewCollection.find({ gigId }).toArray();
  res.send(result);
});

app.post("/reviews", verifyToken, async (req, res) => {
  const reviewData = req.body;
  const result = await reviewCollection.insertOne({
    ...reviewData,
    createdAt: new Date(),
  });
  res.send(result);
});

// ---------- AI Content Generator ----------

app.post("/ai/generate-description", verifyToken, async (req, res) => {
  const { title, category, keywords, length } = req.body;

  if (!title || !category) {
    return res.status(400).json({ message: "Title and category are required" });
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const lengthGuide = length === "short" ? "50-80 words" : length === "long" ? "150-200 words" : "90-130 words";

    const prompt = `Write a professional, compelling freelance gig description for a marketplace listing.
Title: ${title}
Category: ${category}
Keywords/skills to highlight: ${keywords || "none specified"}
Length: approximately ${lengthGuide}

Write only the description text, no headers, no markdown formatting, no quotation marks around it.`;

    const result = await model.generateContent(prompt);
    const description = result.response.text();

    res.json({ description });
  } catch (error) {
    console.error("AI generation failed:", error);
    res.status(500).json({ message: "Failed to generate description" });
  }
});

// ---------- Chatbot ----------

app.post("/chat", async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ reply: "Invalid request format." });
  }

  try {
    const formattedMessages = [
      {
        role: "system",
        content: `You are the GigsVerse support assistant. Only answer using the facts below — never invent button names, pages, or flows that aren't listed here. If you're unsure, say you're not sure and suggest visiting the Help page.

GigsVerse facts:
- To browse gigs: go to the Gigs page, use the search bar, category filter, and price filter, then sort by price or popularity.
- To place an order: open a gig's detail page and click "Order Now", review the price and delivery time, then confirm.
- To list a gig (sell a service): log in, then click "Add Gig" in the navbar. Fill in title, description, image URL, category, price, and delivery time, then submit.
- To manage your gigs: go to "My Listings" from the profile menu — edit or delete anytime.
- To view your orders: go to "My Orders" from the profile menu.
- Login options: email/password or Google sign-in.
- Support email: gigsverse@gmail.com, support hours Mon-Fri 9am-6pm.

Keep answers short and friendly.`,
      },
      ...messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: formattedMessages,
    });

    const reply = completion.choices[0]?.message?.content ?? "Sorry, I couldn't generate a response.";

    res.json({ reply });
  } catch (error) {
    console.error("Chat generation failed:", error);
    res.status(500).json({ reply: "Something went wrong. Please try again." });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`GigsVerse server listening on port ${port}`);
  });
}

module.exports = app;