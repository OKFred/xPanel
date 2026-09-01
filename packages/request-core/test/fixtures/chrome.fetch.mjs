const headers = {
  Authorization: "Bearer secret-token",
  "Content-Type": "application/json",
};

await globalThis.fetch("https://api.example.com/v1/items?page=2", {
  method: "POST",
  headers,
  body: JSON.stringify({ name: "xPanel" }),
});
