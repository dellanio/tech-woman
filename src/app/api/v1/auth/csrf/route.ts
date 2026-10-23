// RED stub (WP-002 Task 3 slice B): sem comportamento.
export const runtime = 'nodejs';
export async function GET(): Promise<Response> { return new Response(null, { status: 501 }); }
