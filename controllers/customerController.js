const Customer = require('../models/Customer');

exports.getCustomers = async (req, res) => {
  try {
    const customers = await Customer.find({ businessId: req.businessId }).sort('-createdAt');
    res.json(customers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createCustomer = async (req, res) => {
  try {
    const { name, phone, notes } = req.body;
    const customer = await Customer.create({ businessId: req.businessId, name, phone, notes });
    res.status(201).json(customer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true }
    );
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
