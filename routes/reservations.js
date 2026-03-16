var express = require('express');
var router = express.Router();
let mongoose = require('mongoose');
let { checkLogin } = require('../utils/authHandler.js');
let reservationModel = require('../schemas/reservations');
let cartModel = require('../schemas/cart');
let inventoryModel = require('../schemas/inventories');

function normalizeItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw new Error('Danh sach san pham khong hop le');
    }

    let mergedItems = new Map();

    for (const item of rawItems) {
        let product = item && item.product;
        let quantity = Number(item && item.quantity);

        if (!product || !Number.isInteger(quantity) || quantity <= 0) {
            throw new Error('Thong tin san pham hoac so luong khong hop le');
        }

        let productId = product.toString();
        let currentQuantity = mergedItems.get(productId) || 0;
        mergedItems.set(productId, currentQuantity + quantity);
    }

    return Array.from(mergedItems.entries()).map(function ([product, quantity]) {
        return { product, quantity };
    });
}

async function reserveWithItems(userId, items, session) {
    let normalizedItems = normalizeItems(items);

    for (const item of normalizedItems) {
        let inventory = await inventoryModel.findOne({
            product: item.product
        }).session(session);

        if (!inventory) {
            throw new Error('Khong tim thay ton kho cua san pham');
        }

        if (inventory.stock < item.quantity) {
            throw new Error('San pham khong du so luong de dat cho');
        }

        inventory.stock -= item.quantity;
        inventory.reserved += item.quantity;
        await inventory.save({ session: session });
    }

    let reservation = new reservationModel({
        user: userId,
        items: normalizedItems
    });

    reservation = await reservation.save({ session: session });
    return reservation.populate({
        path: 'items.product',
        select: 'title price slug images'
    });
}

router.get('/', checkLogin, async function (req, res, next) {
    let reservations = await reservationModel.find({
        user: req.userId
    }).populate({
        path: 'items.product',
        select: 'title price slug images'
    }).sort({ createdAt: -1 });

    res.send(reservations);
});

router.get('/:id', checkLogin, async function (req, res, next) {
    try {
        let reservation = await reservationModel.findOne({
            _id: req.params.id,
            user: req.userId
        }).populate({
            path: 'items.product',
            select: 'title price slug images'
        });

        if (!reservation) {
            return res.status(404).send({ message: 'Reservation not found' });
        }

        res.send(reservation);
    } catch (error) {
        res.status(404).send({ message: 'Reservation not found' });
    }
});

router.post('/reserveACart', checkLogin, async function (req, res, next) {
    let session = await mongoose.startSession();
    session.startTransaction();

    try {
        let currentCart = await cartModel.findOne({
            user: req.userId
        }).session(session);

        if (!currentCart || currentCart.items.length === 0) {
            throw new Error('Gio hang dang trong');
        }

        let reservation = await reserveWithItems(req.userId, currentCart.items, session);
        currentCart.items = [];
        await currentCart.save({ session: session });

        await session.commitTransaction();
        session.endSession();
        res.send(reservation);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(400).send({ message: error.message });
    }
});

router.post('/reserveItems', checkLogin, async function (req, res, next) {
    let session = await mongoose.startSession();
    session.startTransaction();

    try {
        let items = req.body.items || req.body.products || req.body;
        let reservation = await reserveWithItems(req.userId, items, session);

        await session.commitTransaction();
        session.endSession();
        res.send(reservation);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(400).send({ message: error.message });
    }
});

router.post('/cancelReserve/:id', checkLogin, async function (req, res, next) {
    try {
        let reservation = await reservationModel.findOne({
            _id: req.params.id,
            user: req.userId
        });

        if (!reservation) {
            return res.status(404).send({ message: 'Reservation not found' });
        }

        if (reservation.status === 'CANCELLED') {
            return res.status(400).send({ message: 'Reservation da bi huy truoc do' });
        }

        for (const item of reservation.items) {
            let inventory = await inventoryModel.findOne({
                product: item.product
            });

            if (!inventory) {
                return res.status(404).send({ message: 'Khong tim thay ton kho cua san pham' });
            }

            inventory.reserved = Math.max(0, inventory.reserved - item.quantity);
            inventory.stock += item.quantity;
            await inventory.save();
        }

        reservation.status = 'CANCELLED';
        await reservation.save();

        reservation = await reservation.populate({
            path: 'items.product',
            select: 'title price slug images'
        });

        res.send(reservation);
    } catch (error) {
        res.status(400).send({ message: error.message });
    }
});

module.exports = router;
