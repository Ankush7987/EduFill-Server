const Question = require('../models/Question');

// 🚀 CACHE TEST PAPERS (Prevents DB crash during mass mock tests) 🚀
const testCache = new Map();

// Clears cache every 1 hour
setInterval(() => {
    testCache.clear();
    console.log("🧹 Test Cache auto-cleared.");
}, 60 * 60 * 1000); 

exports.getMockTest = async (req, res) => {
    try {
        const { subject, year, limit = 10 } = req.query;
        
        // 🌟 CHECK CACHE FIRST 🌟
        const cacheKey = `${subject || 'All'}-${year || 'All'}-${limit}`;
        if (testCache.has(cacheKey)) {
            return res.status(200).json(testCache.get(cacheKey));
        }

        let query = { exam: 'NEET' };

        if (subject && subject !== 'All') query.subject = subject;
        if (year && year !== 'All') query.year = parseInt(year);

        // 🚀 HIGH-PERFORMANCE RANDOMIZATION 🚀
        // Aggregation $sample is slow on huge collections. If you have >100k questions later,
        // you might want to use randomized indexing. For now, this is optimized.
        const questions = await Question.aggregate([
            { $match: query },
            { $sample: { size: parseInt(limit) } },
            // Project only needed fields to save bandwidth & memory
            { $project: { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 } } 
        ]);

        const response = { success: true, count: questions.length, questions };
        
        // Cache the generated test so the next 1000 students get it instantly
        testCache.set(cacheKey, response);

        res.status(200).json(response);

    } catch (error) {
        console.error("Test Generation Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};