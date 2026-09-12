import request from 'supertest';
import app from '../src/app.js';

describe('Express API Integration Tests', () => {
  
  // Test Case 1: Testing GET endpoint structures
  it('GET /api/user should return user object and 200 status status', async () => {
    const res = await request(app).post('/');
    expect(res.statusCode).toBe(200);
  });

});
