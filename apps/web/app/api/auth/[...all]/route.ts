import { auth } from '../../../../lib/server';

export const GET = (request: Request) => auth().handler(request);
export const POST = (request: Request) => auth().handler(request);
