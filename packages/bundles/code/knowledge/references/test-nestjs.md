---
tags: [testing, nestjs, jest, backend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [backend, monorepo]
summary: |
  NestJS testing patterns — Jest defaults, controller validation, service
  input/output mapping, auth guard behavior, error response shapes.
when_to_load: |
  Task writes or changes tests for a NestJS backend, OR review of test code
  in a NestJS project. jest.config present.
agent_hints: [test, acceptance, logic-reviewer]
---

# Testing: NestJS

## Framework Detection
- `jest.config.*` or `package.json "jest"` → Jest (built-in with NestJS)

## What to Test
**Controllers / Endpoints:**
- Request validation (missing fields, wrong types via class-validator)
- Success response shape
- Error responses (401, 403, 404, 422)
- Auth guard behavior

**Services:**
- Input → output mapping
- Error handling paths
- Edge cases

**Guards / Pipes / Interceptors:**
- Guard returns true/false correctly based on request context
- Pipe transforms/validates input correctly
- Interceptor modifies response as expected

## File Naming
- Unit tests: `*.spec.ts` (colocated with source)
- E2E tests: `*.e2e-spec.ts` in `test/` directory

## Module Setup
```typescript
const module = await Test.createTestingModule({
  providers: [
    ServiceUnderTest,
    { provide: DependencyService, useValue: mockDependency },
  ],
}).compile();

const service = module.get(ServiceUnderTest);
```

## HTTP Testing
Use `supertest` for endpoint tests:
```typescript
const app = module.createNestApplication();
await app.init();
await request(app.getHttpServer())
  .get('/endpoint')
  .expect(200)
  .expect({ data: expected });
```

## Mocking
- `overrideProvider(Service).useValue(mock)` in TestingModule
- `jest.mock()` for external modules
- Custom providers for DB/HTTP mocks
- `@nestjs/testing` utilities for full module compilation

## DTO Validation Testing
Test that class-validator decorators reject invalid input:
```typescript
const dto = plainToInstance(CreateUserDto, { name: '' });
const errors = await validate(dto);
expect(errors.length).toBeGreaterThan(0);
```

## Do NOT
- Test NestJS framework internals (DI resolution, module loading)
- Leave real DB/HTTP calls in unit tests
- Share state between tests (each test gets fresh module)
- Test generated code (Prisma client, TypeORM entities with no custom logic)
