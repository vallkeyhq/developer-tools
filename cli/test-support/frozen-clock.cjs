'use strict';

const now = Number(process.env.VALLKEY_TEST_NOW);
if (!Number.isSafeInteger(now)) throw new Error('VALLKEY_TEST_NOW must be an integer timestamp');
Date.now = () => now;
