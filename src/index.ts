import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import express from 'express';
import http from 'http';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { PubSub } from 'graphql-subscriptions';
import Redis from 'ioredis';
import { z } from 'zod';

const pubsub = new PubSub();
const redis = new Redis({ host: 'localhost', port: 6379 });

const typeDefs = `#graphql
  scalar DateTime

  type User {
    id: ID!
    email: String!
    username: String!
    role: Role!
    createdAt: DateTime!
  }

  enum Role {
    USER
    ADMIN
  }

  type Product {
    id: ID!
    name: String!
    description: String
    price: Float!
    category: String
    stock: Int!
    createdBy: User
    createdAt: DateTime!
  }

  type Order {
    id: ID!
    user: User!
    items: [OrderItem!]!
    total: Float!
    status: OrderStatus!
    createdAt: DateTime!
  }

  type OrderItem {
    product: Product!
    quantity: Int!
    price: Float!
  }

  enum OrderStatus {
    PENDING
    CONFIRMED
    SHIPPED
    DELIVERED
    CANCELLED
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  type Pagination {
    total: Int!
    pages: Int!
    page: Int!
    limit: Int!
  }

  type ProductConnection {
    items: [Product!]!
    pagination: Pagination!
  }

  input RegisterInput {
    email: String!
    password: String!
    username: String!
  }

  input LoginInput {
    email: String!
    password: String!
  }

  input CreateProductInput {
    name: String!
    description: String
    price: Float!
    category: String
    stock: Int
  }

  input ProductFilter {
    category: String
    minPrice: Float
    maxPrice: Float
    search: String
  }

  input PaginationInput {
    page: Int
    limit: Int
  }

  type Query {
    me: User
    users: [User!]!
    products(filter: ProductFilter, pagination: PaginationInput): ProductConnection!
    product(id: ID!): Product
    orders: [Order!]!
    order(id: ID!): Order
  }

  type Mutation {
    register(input: RegisterInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
    createProduct(input: CreateProductInput!): Product!
    updateProduct(id: ID!, input: CreateProductInput!): Product!
    deleteProduct(id: ID!): Boolean!
    createOrder(items: [OrderItemInput!]!): Order!
    updateOrderStatus(id: ID!, status: OrderStatus!): Order!
  }

  input OrderItemInput {
    productId: ID!
    quantity: Int!
  }

  type Subscription {
    orderStatusChanged(orderId: ID): Order!
    productCreated: Product!
  }
`;

// In-memory stores (replace with DB in production)
const users = new Map();
const products = new Map();
const orders = new Map();

// Validation schemas
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  username: z.string().min(3).max(30)
});

const CreateProductSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  price: z.number().positive(),
  category: z.string().optional(),
  stock: z.number().int().min(0).optional()
});

// Auth context
interface Context {
  user?: { id: string; email: string; role: string };
  redis: Redis;
}

function getUser(token: string | undefined): { id: string; email: string; role: string } | undefined {
  if (!token) return undefined;
  try {
    return jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET || 'secret') as any;
  } catch {
    return undefined;
  }
}

const resolvers = {
  Query: {
    me: async (_: any, __: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');
      return users.get(ctx.user.id);
    },
    users: async (_: any, __: any, ctx: Context) => {
      if (!ctx.user || ctx.user.role !== 'ADMIN') throw new Error('Not authorized');
      return Array.from(users.values());
    },
    products: async (_: any, { filter, pagination }: any) => {
      let items = Array.from(products.values());

      if (filter?.category) items = items.filter((p: any) => p.category === filter.category);
      if (filter?.minPrice) items = items.filter((p: any) => p.price >= filter.minPrice);
      if (filter?.maxPrice) items = items.filter((p: any) => p.price <= filter.maxPrice);
      if (filter?.search) {
        const search = filter.search.toLowerCase();
        items = items.filter((p: any) => p.name.toLowerCase().includes(search));
      }

      const page = pagination?.page || 1;
      const limit = pagination?.limit || 20;
      const total = items.length;
      const start = (page - 1) * limit;

      return {
        items: items.slice(start, start + limit),
        pagination: { total, pages: Math.ceil(total / limit), page, limit }
      };
    },
    product: async (_: any, { id }: any) => products.get(id),
    orders: async (_: any, __: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');
      return Array.from(orders.values()).filter((o: any) => o.userId === ctx.user!.id);
    },
    order: async (_: any, { id }: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');
      const order = orders.get(id);
      if (order && order.userId !== ctx.user.id && ctx.user.role !== 'ADMIN') {
        throw new Error('Not authorized');
      }
      return order;
    }
  },
  Mutation: {
    register: async (_: any, { input }: any) => {
      const validated = RegisterSchema.parse(input);

      for (const user of users.values()) {
        if ((user as any).email === validated.email) {
          throw new Error('Email already registered');
        }
      }

      const bcrypt = require('bcryptjs');
      const id = Date.now().toString();
      const user = {
        id,
        email: validated.email,
        username: validated.username,
        role: 'USER',
        passwordHash: await bcrypt.hash(validated.password, 12),
        createdAt: new Date().toISOString()
      };

      users.set(id, user);

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '7d' }
      );

      const { passwordHash, ...userWithoutPassword } = user;
      return { token, user: userWithoutPassword };
    },
    login: async (_: any, { input }: any) => {
      const bcrypt = require('bcryptjs');

      let foundUser: any;
      for (const user of users.values()) {
        if ((user as any).email === input.email) {
          foundUser = user;
          break;
        }
      }

      if (!foundUser) throw new Error('Invalid credentials');

      const valid = await bcrypt.compare(input.password, foundUser.passwordHash);
      if (!valid) throw new Error('Invalid credentials');

      const token = jwt.sign(
        { id: foundUser.id, email: foundUser.email, role: foundUser.role },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '7d' }
      );

      const { passwordHash, ...userWithoutPassword } = foundUser;
      return { token, user: userWithoutPassword };
    },
    createProduct: async (_: any, { input }: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');

      const validated = CreateProductSchema.parse(input);
      const id = Date.now().toString();
      const product = {
        id,
        ...validated,
        stock: validated.stock || 0,
        createdBy: ctx.user.id,
        createdAt: new Date().toISOString()
      };

      products.set(id, product);
      pubsub.publish('PRODUCT_CREATED', { productCreated: product });

      return product;
    },
    updateProduct: async (_: any, { id, input }: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');

      const product = products.get(id);
      if (!product) throw new Error('Product not found');

      const validated = CreateProductSchema.parse(input);
      const updated = { ...product, ...validated };
      products.set(id, updated);

      return updated;
    },
    deleteProduct: async (_: any, { id }: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');
      if (!products.has(id)) throw new Error('Product not found');
      products.delete(id);
      return true;
    },
    createOrder: async (_: any, { items }: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');

      let total = 0;
      const orderItems = items.map((item: any) => {
        const product = products.get(item.productId);
        if (!product) throw new Error(`Product ${item.productId} not found`);
        total += (product as any).price * item.quantity;
        return { product, quantity: item.quantity, price: (product as any).price };
      });

      const id = Date.now().toString();
      const order = {
        id,
        userId: ctx.user.id,
        items: orderItems,
        total,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      };

      orders.set(id, order);
      return order;
    },
    updateOrderStatus: async (_: any, { id, status }: any, ctx: Context) => {
      if (!ctx.user) throw new Error('Not authenticated');

      const order = orders.get(id);
      if (!order) throw new Error('Order not found');

      (order as any).status = status;
      orders.set(id, order);

      pubsub.publish(`ORDER_STATUS_${id}`, { orderStatusChanged: order });

      return order;
    }
  },
  Subscription: {
    orderStatusChanged: {
      subscribe: (_: any, { orderId }: any) => {
        return orderId
          ? pubsub.asyncIterator([`ORDER_STATUS_${orderId}`])
          : pubsub.asyncIterator(['ORDER_STATUS_*']);
      }
    },
    productCreated: {
      subscribe: () => pubsub.asyncIterator(['PRODUCT_CREATED'])
    }
  },
  User: {
    __resolveType: () => 'User'
  },
  Product: {
    createdBy: async (product: any) => users.get(product.createdBy)
  },
  Order: {
    user: (order: any) => users.get(order.userId)
  }
};

async function startServer() {
  const app = express();
  const httpServer = createServer(app);

  const schema = makeExecutableSchema({ typeDefs, resolvers });

  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql'
  });

  const serverCleanup = useServer({ schema }, wsServer);

  const server = new ApolloServer({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            }
          };
        }
      }
    ]
  });

  await server.start();

  app.use(
    '/graphql',
    cors<cors.CorsRequest>(),
    express.json(),
    expressMiddleware(server, {
      context: async ({ req }) => {
        const token = req.headers.authorization;
        const user = getUser(token);
        return { user, redis };
      }
    })
  );

  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'graphql-api' });
  });

  const PORT = process.env.PORT || 4000;
  httpServer.listen(PORT, () => {
    console.log(`GraphQL API ready at http://localhost:${PORT}/graphql`);
    console.log(`Subscriptions ready at ws://localhost:${PORT}/graphql`);
  });
}

startServer();
