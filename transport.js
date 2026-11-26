async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error('Local request failed');
  return response.json();
}

export const snapshot = () => request('/api/state');
export const command = (input) => request('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spread-Watch': '1' },
  body: JSON.stringify(input),
});
