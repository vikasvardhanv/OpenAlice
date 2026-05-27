import { http, HttpResponse } from 'msw'
import { demoNewsArticles } from '../fixtures/news'

export const notificationsNewsHandlers = [
  http.get('/api/notifications/history', () => HttpResponse.json({ entries: [], hasMore: false })),
  http.get('/api/news', () =>
    HttpResponse.json({ items: demoNewsArticles, count: demoNewsArticles.length, lookback: '24h' }),
  ),
]
