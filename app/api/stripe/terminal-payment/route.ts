import { NextResponse } from 'next/server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  try {
    const { amount, currency, description, metadata } = await req.json();
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // En centavos
      currency,
      description,
      metadata,
      payment_method_types: ['card_present'],
      capture_method: 'automatic'
    });
    
    return NextResponse.json({
      client_secret: paymentIntent.client_secret,
      id: paymentIntent.id
    });
    
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
