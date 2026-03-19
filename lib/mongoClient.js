const { MongoClient } = require('mongodb');

let client;

async function getMongoClient() {
  if (!client) {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
  }
  return client;
}

module.exports = { getMongoClient };
