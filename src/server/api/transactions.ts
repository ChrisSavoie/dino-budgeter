import _ from "lodash";
import { distributeTotal } from "../../shared/transactions";
import { CategoryId, Transaction, TransactionId, User } from "../../shared/types";
import * as util from "../../shared/util";
import { StatusCodeNoResponse } from "../api";
import db from "../db";
import * as transactions from "../transactions";
import * as user from "../user";
import * as payments from "../payments";
import { AddTransactionRequest, DeleteTransactionRequest, TransactionDescriptionRequest, TransactionAmountRequest, TransactionDateRequest, TransactionCategoryRequest, TransactionSplitRequest } from "../../shared/api";

export function handle_transaction_post(request: AddTransactionRequest, actor: User): Promise<Transaction | StatusCodeNoResponse> {
    const other = request.split ? request.split.with : undefined;
    const payer = request.split ? request.split.iPaid ? actor.uid : other : undefined;
    if (!request.amount.isValid(false /** allowNegative */)) {
        return Promise.resolve(400 as StatusCodeNoResponse);
    }
    if (request.split) {
        if (!request.split.otherAmount.isValid(false) ||
            !request.split.myShare.isValid(false) ||
            !request.split.theirShare.isValid(false)) {
            console.log("Split validation failed");
            return Promise.resolve(400 as StatusCodeNoResponse);
        }
        const total = request.amount.plus(request.split.otherAmount);
        const [calcAmount, calcOtherAmount] = distributeTotal(total, request.split.myShare, request.split.theirShare);
        if (calcAmount.string() != request.amount.string() || calcOtherAmount.string() != request.split.otherAmount.string()) {
            console.log("Calculated different values for split");
            return Promise.resolve(400 as StatusCodeNoResponse);
        }
    }
    const tx_id = util.randomId();
    return db.tx(async t => {
        if (other && !await user.isFriend(actor.uid, other, t)) {
            return 400 as StatusCodeNoResponse;
        }
        const gid = await user.getDefaultGroup(actor, t);
        const query = "insert into transactions (id, gid, frame, amount, description, category, date) values ($1, $2, $3, $4, $5, $6, $7)";
        await t.none(query,
            [tx_id, gid, request.frame, request.amount.string(), request.description, request.category || null, request.date]);
        let split = undefined;
        if (other) {
            const other_id = util.randomId();
            const other_friend = await user.getFriend(other, t);
            const other_gid = other_friend.gid;
            const other_cat: CategoryId = null;
            const sid = util.randomId();
            split = {
                id: sid,
                with: other_friend,
                settled: false,
                myShare: request.split.myShare,
                theirShare: request.split.theirShare,
                otherAmount: request.split.otherAmount,
                payer,
            };
            const balance = transactions.getBalance({
                user: actor.uid,
                otherUser: other,
                amount: request.amount,
                otherAmount: request.split.otherAmount,
                payer,
            });
            await t.batch([
                payments.addToBalance(actor.uid, other, balance, t),
                t.none(query, [other_id, other_gid, request.frame, request.split.otherAmount.string(), request.description, other_cat, request.date]),
                t.none(`insert into shared_transactions (id, payer, settled) values ($1, $2, true)`, [sid, payer]),
                t.none(`insert into transaction_splits (tid, sid, share) values ($1, $2, $3)`, [tx_id, sid, request.split.myShare.string()]),
                t.none(`insert into transaction_splits (tid, sid, share) values ($1, $2, $3)`, [other_id, sid, request.split.theirShare.string()]),
            ]);
        }
        const transaction: Transaction = {
            id: tx_id,
            gid,
            frame: request.frame,
            category: request.category,
            amount: request.amount,
            description: request.description,
            alive: true,
            date: request.date,
            split
        };
        return transaction;
    });
}

type txField = "amount" | "date" | "description" | "category";
function isSharedField(field: txField): boolean {
    return field == "date" || field == "description";
}
function canEditShared(field: txField): boolean {
    return field != "amount";
}

export function handle_transaction_delete(request: DeleteTransactionRequest, actor: User): Promise<StatusCodeNoResponse> {
    return db.tx(async t => {
        if (!(await transactions.canUserEdit(request.id, actor.uid, t))) {
            // Maybe no auth? maybe no exists? maybe no id at all?
            return 400;
        }
        await transactions.deleteTransaction(request.id, t);
        return 204 as StatusCodeNoResponse;
    });
}

export function handle_transaction_description_post(request: TransactionDescriptionRequest, actor: User): Promise<StatusCodeNoResponse> {
    return handle_transaction_update_post("description", request, actor, d => !!d);
}

export function handle_transaction_amount_post(request: TransactionAmountRequest, actor: User): Promise<StatusCodeNoResponse> {
    return handle_transaction_update_post("amount", request, actor,
        amount => amount.isValid(),
        amount => amount.string());
}

export function handle_transaction_date_post(request: TransactionDateRequest, actor: User): Promise<StatusCodeNoResponse> {
    return handle_transaction_update_post("date", request, actor);
}

export function handle_transaction_category_post(request: TransactionCategoryRequest, actor: User): Promise<StatusCodeNoResponse> {
    // TODO: validate that the category exists, is alive, is owned by the user, etc.
    return handle_transaction_update_post("category", request, actor, undefined, c => c || null);
}

function handle_transaction_update_post<Request extends {id: TransactionId}, Field extends Exclude<keyof Request, 'id'> & txField>(
        field: Field,
        request: Request,
        actor: User,
        isValid?: (val: Request[Field]) => boolean,
        transform?: (val: Request[Field]) => string): Promise<StatusCodeNoResponse> {
    const value = request[field];
    if (!isValid) isValid = () => true;
    if (!transform) {
        if (typeof value == "string") {
            transform = (s) => s as typeof value;
        } else {
            throw Error("Must provide a transform for a non-string value in " + field);
        }
    }
    if (!isValid(value)) {
        return Promise.resolve(400 as StatusCodeNoResponse);
    }
    const updateLinked = isSharedField(field);
    const id = request.id;
    return db.tx(async t => {
        const existing = await transactions.getTransaction(id, t);
        if (existing.gid != await user.getDefaultGroup(actor, t)) {
            return 401;
        }
        if (existing.split && !canEditShared(field)) {
            console.log("Can't edit " + field + " on a shared transaction");
            return 400;
        }
        const val = transform(value);
        const query = "update transactions set " + field + " = $1 where id = $2";
        await t.none(query, [val, id]);
        if (updateLinked && existing.split) {
            await t.none(query, [val, await transactions.getOtherTid(id, existing.split.id, t)]);
        }
        return 204 as StatusCodeNoResponse;
    });
}

export function handle_transaction_split_post(request: TransactionSplitRequest, actor: User): Promise<StatusCodeNoResponse> {
    const {tid, sid, total, myShare, theirShare} = request;
    if (!total.isValid(false) ||
        !myShare.isValid(false) ||
        !theirShare.isValid(false) ||
        !tid || !sid) {
        return Promise.resolve(400 as StatusCodeNoResponse);
    }
    const [myAmount, otherAmount] = distributeTotal(total, myShare, theirShare);
    return  db.tx(async t => {
        const otherTid = await transactions.getOtherTid(tid, sid, t);
        const otherUid = await transactions.getUser(otherTid, t);
        const payer = request.iPaid ? actor.uid : otherUid;

        // Update the friendship balance
        const prevBalance = await transactions.getBalanceFromDb(tid, t);
        const newBalance = transactions.getBalance({
            user: actor.uid,
            otherUser: otherUid,
            amount: myAmount,
            otherAmount: otherAmount,
            payer: payer,
        });
        const balanceDelta = newBalance.minus(prevBalance);

        const work = [
            payments.addToBalance(actor.uid, otherUid, balanceDelta, t),
            t.none("update transactions set amount = $1 where id = $2", [myAmount.string(), tid]),
            t.none("update transactions set amount = $1 where id = $2", [otherAmount.string(), otherTid]),
            t.none("update transaction_splits set share = $1 where tid = $2", [myShare.string(), tid]),
            t.none("update transaction_splits set share = $1 where tid = $2", [theirShare.string(), otherTid]),
            t.none("update shared_transactions set payer = $1 where id = $2", [payer, sid]),
        ];
        await t.batch(work);
        return 204 as StatusCodeNoResponse;
    });
}
