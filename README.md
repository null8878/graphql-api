# GraphQL API

Production-ready GraphQL API with Apollo Server, TypeScript, authentication, and real-time subscriptions.

## Features

- Apollo Server with TypeScript
- JWT authentication with role-based access
- Real-time subscriptions via WebSocket
- DataLoader for N+1 query prevention
- Input validation with custom directives
- Query complexity analysis
- Schema federation ready
- Redis caching layer

## Quick Start

```bash
npm install
npm run dev
```

## API

```graphql
# Authentication
mutation {
  register(input: { email: "user@example.com", password: "pass", username: "user" }) {
    token
    user { id email username }
  }
}

# Queries
query {
  products(pagination: { page: 1, limit: 10 }) {
    items { id name price }
    pagination { total pages }
  }
}

# Subscriptions
subscription {
  orderStatusChanged(orderId: "123") {
    status
    updatedAt
  }
}
```

## License

MIT
