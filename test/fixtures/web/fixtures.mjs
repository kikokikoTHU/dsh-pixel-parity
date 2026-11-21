export default async function setup(page) {
  await page.route('**/api.example.test/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ color: '#123456' }),
  }))
}
